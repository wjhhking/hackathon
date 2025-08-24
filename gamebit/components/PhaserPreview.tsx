'use client'

import { useEffect, useRef } from 'react'
import type { CompositionPlan } from '@/lib/composition'
import { buildRuntimeOps } from '@/lib/composition/builder'
import type { RuntimeOps } from '@/lib/composition/runtimeOps'

// Lazy import phaser only on client
let PhaserLib: typeof import('phaser') | null = null

const NORMALIZE: Record<string, string> = {
  'tetrominoes': 'tetrisCore',
  'rules.lineClear': 'lineClear',
  'controls.orthogonalStep': 'gridStep',
  'controls.inputAxis': 'inputAxis',
  'controller.orthogonalStep': 'gridStep',
  'controller.inputAxis': 'inputAxis',
  'controller.rotate': 'tetrisCore',
  'spawn.tetromino': 'tetrisCore',
  'hud.basic': 'hudBasic',
  'ui.hudBasic': 'hudBasic',
  'tick': 'gridStep',
  'stepper': 'gridStep'
}

function normalizeOps(ops: RuntimeOps): RuntimeOps {
  const normalized = { ...ops, systems: ops.systems.map(s => ({ ...s })) }
  normalized.systems.forEach(s => {
    const mapped = NORMALIZE[s.type]
    if (mapped) s.type = mapped
  })
  return normalized
}

export default function PhaserPreview({ runtimeOps: providedOps, plan, width = 800, height = 480 }: { runtimeOps?: RuntimeOps; plan?: CompositionPlan; width?: number; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const gameRef = useRef<import('phaser').Game | null>(null)

  useEffect(() => {
    let mounted = true

    async function boot() {
      if (!mounted || !containerRef.current) return

      if (gameRef.current) {
        gameRef.current.destroy(true)
        gameRef.current = null
      }
      containerRef.current.innerHTML = ''
      containerRef.current.setAttribute('tabindex', '0')
      containerRef.current.style.outline = 'none'
      
      // Add focus/blur debugging
      containerRef.current.addEventListener('focus', () => console.debug('[preview] container focused'))
      containerRef.current.addEventListener('blur', () => console.debug('[preview] container blurred'))
      
      // Add keydown debugging on container
      containerRef.current.addEventListener('keydown', (e) => {
        console.debug('[preview] container keydown:', e.key, e.code)
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp'].includes(e.code)) {
          e.preventDefault()
        }
      })
      
      containerRef.current.focus()
      console.debug('[preview] focus() called on container')

      if (!PhaserLib) {
        PhaserLib = (await import('phaser')).default as unknown as typeof import('phaser')
      }
      if (!mounted || !containerRef.current) return

      const Phaser = PhaserLib!

      // Use provided runtimeOps first, then localStorage, then build from plan
      let ops: RuntimeOps | null = providedOps || null
      if (!ops && typeof window !== 'undefined') {
        const saved = localStorage.getItem('runtimeOps')
        if (saved) ops = JSON.parse(saved)
      }
      if (!ops && plan) ops = buildRuntimeOps(plan)
      if (!ops) {
        console.error('[preview] No runtimeOps available')
        return
      }
      ops = normalizeOps(ops)

      try { console.debug('[preview] runtimeOps systems:', ops.systems.map(s => s.type)) } catch {}

      const config: import('phaser').Types.Core.GameConfig = {
        type: Phaser.AUTO,
        width,
        height,
        parent: containerRef.current,
        backgroundColor: '#0b1020',
        input: { keyboard: true },
        scene: {
          create(this: import('phaser').Scene) {
            const scene = this as import('phaser').Scene
            
            // Try direct key listening instead of cursors
            let keys = {
              left: false,
              right: false,
              up: false,
              down: false
            }
            
            // Listen to window keydown/keyup events
            const handleKeyDown = (e: KeyboardEvent) => {
              console.log('🔥 KEY DOWN:', e.key, e.code, 'keys before:', {...keys})
              if (e.code === 'ArrowLeft') { keys.left = true; e.preventDefault() }
              if (e.code === 'ArrowRight') { keys.right = true; e.preventDefault() }
              if (e.code === 'ArrowUp') { keys.up = true; e.preventDefault() }
              if (e.code === 'ArrowDown') { keys.down = true; e.preventDefault() }
              console.log('🔥 keys after:', {...keys})
            }
            
            const handleKeyUp = (e: KeyboardEvent) => {
              console.log('🔥 KEY UP:', e.key, e.code)
              if (e.code === 'ArrowLeft') keys.left = false
              if (e.code === 'ArrowRight') keys.right = false
              if (e.code === 'ArrowUp') keys.up = false
              if (e.code === 'ArrowDown') keys.down = false
            }
            
            window.addEventListener('keydown', handleKeyDown)
            window.addEventListener('keyup', handleKeyUp)
            
            // Store cleanup function
            scene.data.set('keyCleanup', () => {
              window.removeEventListener('keydown', handleKeyDown)
              window.removeEventListener('keyup', handleKeyUp)
            })
            
            if (scene.input.keyboard) {
              scene.input.keyboard.enabled = true
              scene.input.keyboard.addCapture([
                Phaser.Input.Keyboard.KeyCodes.LEFT,
                Phaser.Input.Keyboard.KeyCodes.RIGHT,
                Phaser.Input.Keyboard.KeyCodes.UP,
                Phaser.Input.Keyboard.KeyCodes.DOWN
              ])
            }

            const { tileSize, width: cols, height: rows, wrapEdges } = ops!.world
            const worldW = cols * tileSize
            const worldH = rows * tileSize
            const scale = Math.min(width / worldW, height / worldH)

            const g = scene.add.graphics()
            g.lineStyle(1, 0xffffff, 0.1)
            for (let c = 0; c <= cols; c++) {
              const x = Math.floor(c * tileSize * scale) + 0.5
              g.lineBetween(x, 0, x, Math.floor(rows * tileSize * scale))
            }
            for (let r = 0; r <= rows; r++) {
              const y = Math.floor(r * tileSize * scale) + 0.5
              g.lineBetween(0, y, Math.floor(cols * tileSize * scale), y)
            }

            const systems = ops!.systems
            const getSystems = (t: string) => systems.filter(s => s.type === t)
            const hasSystem = (t: string) => systems.some(s => s.type === t)

            const cursors = scene.input.keyboard?.createCursorKeys()!
            console.debug('[preview] cursors created:', !!cursors)

            // Simple game detection based on key system types
            const systemTypesList = systems.map(s => s.type)
            
            // Check for specific Tetris indicators
            const isTetris = systemTypesList.some(type => 
              type.includes('tetromino') || 
              type.includes('lineClear') || 
              type === 'tetrisCore'
            )
            
            // Check for specific Snake indicators  
            const isSnake = !isTetris && (
              systemTypesList.some(type =>
                type.includes('snakeBody') ||
                type.includes('actor.snake') ||
                type.includes('foodUniform') ||
                type.includes('growthOnEat') ||
                type.includes('snakeMovement') ||
                type.includes('foodSpawner')
              ) ||
              // Also check if we have snake entities
              ops!.entities?.some(e => 
                e.id === 'snake' || 
                e.name?.toLowerCase().includes('snake') ||
                e.components.some(c => (c as any).type === 'Snake')
              )
            )

            console.log('🎮 SIMPLE GAME DETECTION:', { 
              systemTypes: systemTypesList,
              isTetris,
              isSnake,
              entities: ops!.entities?.map(e => ({ id: e.id, name: e.name, componentTypes: e.components.map(c => (c as any).type) }))
            })

            if (isSnake) {
              console.log('🐍 RUNNING SNAKE GAME')
              runSnakeLike(scene, ops!, scale, wrapEdges, { keys, hasSystem, getSystems })
            } else if (isTetris) {
              console.log('🎮 RUNNING TETRIS GAME')
              runTetris(scene, ops!, scale, { keys, hasSystem, getSystems })
            } else {
              console.log('❓ NO SPECIFIC GAME DETECTED, showing generic preview')
            }

            let controlsText = 'Controls: Arrow keys'
            if (isTetris) {
              controlsText = 'Controls: ← → move, ↑ rotate, ↓ soft drop'
            } else if (isSnake) {
              controlsText = 'Controls: ← → ↑ ↓ change direction'
            }
            
            const info = [`World ${cols}x${rows} t=${tileSize}`, `Systems: ${systems.map(s => s.type).join(', ')}`, controlsText]
            scene.add.text(12, 12, info.join('\n'), { fontFamily: 'monospace', fontSize: '12px', color: '#ffffff' })
          }
        }
      }

      gameRef.current = new Phaser.Game(config)
    }

    boot()

    return () => {
      mounted = false
      if (gameRef.current) {
        // Clean up key listeners
        const scene = gameRef.current.scene.getScene('default')
        if (scene && scene.data.get('keyCleanup')) {
          scene.data.get('keyCleanup')()
        }
        gameRef.current.destroy(true)
        gameRef.current = null
      }
      if (containerRef.current) containerRef.current.innerHTML = ''
    }
  }, [providedOps, plan, width, height])

  return (
    <div 
      ref={containerRef} 
      style={{ 
        width: `${width}px`, 
        height: `${height}px`, 
        border: '4px solid #333', 
        background: '#0b1020',
        cursor: 'pointer'
      }}
      onClick={() => {
        console.debug('[preview] container clicked, focusing...')
        containerRef.current?.focus()
      }}
      title="Click to focus, then use arrow keys"
    />
  )
}

function runSnakeLike(scene: import('phaser').Scene, ops: RuntimeOps, scale: number, wrapEdges: boolean | undefined, ctx: { keys: any; hasSystem: (t: string) => boolean; getSystems: (t: string) => any[] }) {
  console.log('🐍 SNAKE SETUP STARTING')
  const { tileSize, width: cols, height: rows } = ops.world
  const Phaser = PhaserLib!

  // Get snake entity data from RuntimeOps
  const snakeEntity = ops.entities?.find(e => 
    e.id === 'snake' || 
    e.id === 'e.snake' || 
    e.name === 'Snake' ||
    e.components.some(c => (c as any).type === 'Snake')
  )
  let startX = Math.floor(cols / 2)
  let startY = Math.floor(rows / 2)
  let startLength = 4
  let snakeColor = 0x34d399

  if (snakeEntity) {
    console.log('🐍 Found snake entity:', snakeEntity)
    
    // Look for position component - handle different structures
    const posComponent = snakeEntity.components.find(c => 
      (c as any).type === 'GridPosition' || 
      (c as any).gridPosition || 
      (c as any).position ||
      ('x' in c && 'y' in c)
    )
    
    if (posComponent) {
      const pos = (posComponent as any)
      // Handle different position structures
      if (pos.type === 'GridPosition') {
        startX = pos.x || startX
        startY = pos.y || startY
      } else if (pos.gridPosition) {
        startX = pos.gridPosition.x || startX
        startY = pos.gridPosition.y || startY
      } else if (pos.position) {
        startX = pos.position.x || startX
        startY = pos.position.y || startY
      } else if ('x' in pos && 'y' in pos) {
        startX = pos.x || startX
        startY = pos.y || startY
      }
    }
    
    // Look for snake body component
    const bodyComponent = snakeEntity.components.find(c => 
      (c as any).type === 'Snake' ||
      (c as any).snakeBody || 
      (c as any).SnakeBody
    )
    
    if (bodyComponent) {
      const body = bodyComponent as any
      if (body.type === 'Snake') {
        // Handle LLM-generated Snake component
        if (body.segments && Array.isArray(body.segments)) {
          startLength = body.segments.length
        }
      } else {
        // Handle legacy formats
        const bodyData = body.snakeBody || body.SnakeBody
        startLength = bodyData.length || bodyData.segments?.length || startLength
      }
    }
    
    // Look for renderable/color component
    const renderComponent = snakeEntity.components.find(c => 
      (c as any).type === 'Renderable' ||
      (c as any).color ||
      (c as any).colorHead
    )
    
    if (renderComponent) {
      const render = renderComponent as any
      if (render.colorHead) {
        try {
          snakeColor = parseInt(render.colorHead.replace('#', '0x'))
        } catch (e) {
          console.warn('Failed to parse snake color:', render.colorHead)
        }
      } else if (render.color) {
        try {
          snakeColor = parseInt(render.color.replace('#', '0x'))
        } catch (e) {
          console.warn('Failed to parse snake color:', render.color)
        }
      }
    }
  }

  console.log('🐍 SNAKE INIT:', { 
    startX, 
    startY, 
    startLength, 
    snakeColor: snakeColor.toString(16),
    foundEntity: !!snakeEntity,
    entityId: snakeEntity?.id
  })

  let axis = { x: 1, y: 0 } // Start moving right
  let lastAxis = { x: 1, y: 0 }
  
  // Update direction based on key input
  const updateDirection = () => {
    const left = ctx.keys.left
    const right = ctx.keys.right
    const up = ctx.keys.up
    const down = ctx.keys.down
    
    if (left && lastAxis.x !== 1) { axis.x = -1; axis.y = 0 }
    else if (right && lastAxis.x !== -1) { axis.x = 1; axis.y = 0 }
    else if (up && lastAxis.y !== 1) { axis.x = 0; axis.y = -1 }
    else if (down && lastAxis.y !== -1) { axis.x = 0; axis.y = 1 }
    
    if (left || right || up || down) {
      console.log('🐍 SNAKE DIRECTION:', { left, right, up, down, axis })
    }
  }

  // Create snake head
  const player = scene.add.rectangle(
    Math.floor(startX * tileSize * scale), 
    Math.floor(startY * tileSize * scale), 
    Math.ceil(tileSize * scale), 
    Math.ceil(tileSize * scale), 
    snakeColor
  )
  player.setOrigin(0, 0)

  const tailRects: import('phaser').GameObjects.Rectangle[] = []
  let tailPositions: Array<{ x: number; y: number }> = []
  
  // Initialize snake with starting length
  for (let i = 1; i < startLength; i++) {
    tailPositions.push({ x: startX - i, y: startY })
  }

  // Add food
  let food: import('phaser').GameObjects.Rectangle | null = null
  const spawnFood = () => {
    if (food) food.destroy()
    
    let fx: number, fy: number
    let attempts = 0
    do {
      fx = Math.floor(Math.random() * cols)
      fy = Math.floor(Math.random() * rows)
      attempts++
    } while (attempts < 50 && (
      (fx === Math.round(player.x / (tileSize * scale)) && fy === Math.round(player.y / (tileSize * scale))) ||
      tailPositions.some(tp => tp.x === fx && tp.y === fy)
    ))
    
    food = scene.add.rectangle(fx * tileSize * scale, fy * tileSize * scale, Math.ceil(tileSize * scale), Math.ceil(tileSize * scale), 0xff6b6b)
    food.setOrigin(0, 0)
    console.log('🐍 FOOD SPAWNED:', { fx, fy })
  }
  spawnFood()

  const stepMs = 150
  scene.time.addEvent({ delay: stepMs, loop: true, callback: () => {
    updateDirection()
    
    let px = Math.round(player.x / (tileSize * scale))
    let py = Math.round(player.y / (tileSize * scale))
    let nx = px + axis.x
    let ny = py + axis.y

    if (wrapEdges) {
      nx = (nx + cols) % cols
      ny = (ny + rows) % rows
    } else if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) {
      console.log('🐍 COLLISION WITH WALL - RESET')
      tailPositions = []
      tailRects.forEach(r => r.destroy())
      tailRects.length = 0
      nx = Math.floor(cols / 2)
      ny = Math.floor(rows / 2)
      axis = { x: 0, y: 0 }
      lastAxis = { x: 0, y: 0 }
    }

    // Check food collision
    if (food) {
      const fx = Math.round(food.x / (tileSize * scale))
      const fy = Math.round(food.y / (tileSize * scale))
      if (nx === fx && ny === fy) {
        console.log('🐍 FOOD EATEN - GROWING')
        tailPositions.push({ x: px, y: py })
        spawnFood()
      }
    }

    // Move tail
    if (tailPositions.length > 0) {
      for (let i = tailPositions.length - 1; i > 0; i--) tailPositions[i] = { ...tailPositions[i - 1] }
      tailPositions[0] = { x: px, y: py }
    }

    // Check self collision
    for (const tp of tailPositions) {
      if (nx === tp.x && ny === tp.y) {
        console.log('🐍 SELF COLLISION - RESET')
        tailPositions = []
        tailRects.forEach(r => r.destroy())
        tailRects.length = 0
        nx = Math.floor(cols / 2)
        ny = Math.floor(rows / 2)
        axis = { x: 0, y: 0 }
        lastAxis = { x: 0, y: 0 }
        break
      }
    }

    player.x = Math.floor(nx * tileSize * scale)
    player.y = Math.floor(ny * tileSize * scale)
    lastAxis = { ...axis }

    // Update tail visuals
    while (tailRects.length < tailPositions.length) {
      const seg = scene.add.rectangle(0, 0, Math.ceil(tileSize * scale), Math.ceil(tileSize * scale), 0x10b981)
      seg.setOrigin(0, 0)
      tailRects.push(seg)
    }
    while (tailRects.length > tailPositions.length) {
      tailRects.pop()?.destroy()
    }
    tailRects.forEach((r, i) => {
      const tp = tailPositions[i]
      r.x = Math.floor(tp.x * tileSize * scale)
      r.y = Math.floor(tp.y * tileSize * scale)
    })
  }})
}

function runTetris(scene: import('phaser').Scene, ops: RuntimeOps, scale: number, ctx: { keys: any; hasSystem: (t: string) => boolean; getSystems: (t: string) => any[] }) {
  console.log('🎯 TETRIS SETUP STARTING')
  const { tileSize, width: cols, height: rows } = ops.world
  const cellW = Math.ceil(tileSize * scale)
  const cellH = Math.ceil(tileSize * scale)
  console.debug('[tetris] grid setup:', { cols, rows, cellW, cellH, scale })

  const grid: (number | null)[][] = Array.from({ length: rows }, () => Array<number | null>(cols).fill(null))
  const cells: import('phaser').GameObjects.Rectangle[][] = Array.from({ length: rows }, () => Array<import('phaser').GameObjects.Rectangle>(cols) as any)

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const r = scene.add.rectangle(x * cellW, y * cellH, cellW, cellH, 0x000000, 0)
      r.setOrigin(0, 0)
      cells[y][x] = r
    }
  }
  function redrawCell(x: number, y: number) {
    const color = grid[y][x]
    const r = cells[y][x]
    r.setFillStyle(color ?? 0x000000, color ? 1 : 0)
  }
  function redrawAll() { for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) redrawCell(x, y) }

  const SHAPES: Array<{ color: number; rots: Array<Array<{ x: number; y: number }>> }> = [
    { color: 0x3b82f6, rots: [ [{x:-1,y:0},{x:0,y:0},{x:1,y:0},{x:2,y:0}], [{x:0,y:-1},{x:0,y:0},{x:0,y:1},{x:0,y:2}], [{x:-1,y:1},{x:0,y:1},{x:1,y:1},{x:2,y:1}], [{x:1,y:-1},{x:1,y:0},{x:1,y:1},{x:1,y:2}] ] },
    { color: 0xf59e0b, rots: [ [{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}], [{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}], [{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}], [{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}] ] },
    { color: 0x8b5cf6, rots: [ [{x:-1,y:0},{x:0,y:0},{x:1,y:0},{x:0,y:1}], [{x:0,y:-1},{x:0,y:0},{x:0,y:1},{x:1,y:0}], [{x:-1,y:0},{x:0,y:0},{x:1,y:0},{x:0,y:-1}], [{x:0,y:-1},{x:0,y:0},{x:0,y:1},{x:-1,y:0}] ] },
    { color: 0x10b981, rots: [ [{x:0,y:0},{x:1,y:0},{x:-1,y:1},{x:0,y:1}], [{x:0,y:-1},{x:0,y:0},{x:1,y:0},{x:1,y:1}], [{x:0,y:0},{x:1,y:0},{x:-1,y:1},{x:0,y:1}], [{x:0,y:-1},{x:0,y:0},{x:1,y:0},{x:1,y:1}] ] },
    { color: 0xef4444, rots: [ [{x:-1,y:0},{x:0,y:0},{x:0,y:1},{x:1,y:1}], [{x:1,y:-1},{x:0,y:0},{x:1,y:0},{x:0,y:1}], [{x:-1,y:0},{x:0,y:0},{x:0,y:-1},{x:1,y:-1}], [{x:0,y:-1},{x:-1,y:0},{x:0,y:0},{x:-1,y:1}] ] },
    { color: 0x2563eb, rots: [ [{x:-1,y:0},{x:0,y:0},{x:1,y:0},{x:-1,y:1}], [{x:0,y:-1},{x:0,y:0},{x:0,y:1},{x:1,y:-1}], [{x:-1,y:0},{x:0,y:0},{x:1,y:0},{x:1,y:-1}], [{x:0,y:-1},{x:0,y:0},{x:0,y:1},{x:-1,y:1}] ] },
    { color: 0xf97316, rots: [ [{x:-1,y:0},{x:0,y:0},{x:1,y:0},{x:1,y:1}], [{x:0,y:-1},{x:0,y:0},{x:0,y:1},{x:-1,y:-1}], [{x:-1,y:0},{x:0,y:0},{x:1,y:0},{x:-1,y:-1}], [{x:0,y:-1},{x:0,y:0},{x:0,y:1},{x:1,y:1}] ] }
  ]

  let current = spawnPiece()
  const gravityTicksParam = ops.systems.find(s => s.type === 'tetrisCore')?.params?.gravityTicks as number | undefined
  const gravityTicks = typeof gravityTicksParam === 'number' ? gravityTicksParam : 48
  let dropMs = Math.max(80, Math.floor(gravityTicks * (1000 / 60)))
  let moveCooldown = 0
  
  console.debug('[tetris] initial piece spawned:', current)
  console.debug('[tetris] drop timing:', { gravityTicks, dropMs })

  function spawnPiece() {
    const s = SHAPES[Math.floor(Math.random() * SHAPES.length)]
    const rot = 0
    const x = Math.floor(cols / 2)
    const y = 0
    return { s, rot, x, y }
  }

  function validAt(x: number, y: number, rot: number) {
    const cellsDef = current.s.rots[rot % 4]
    console.log('🔍 VALIDAT:', { x, y, rot, cellsDef, gridSize: { cols, rows } })
    for (const c of cellsDef) {
      const gx = x + c.x
      const gy = y + c.y
      console.log('🔍 CHECK CELL:', { gx, gy, inBounds: gx >= 0 && gx < cols && gy >= 0 && gy < rows, occupied: gy >= 0 && gy < rows && gx >= 0 && gx < cols ? grid[gy][gx] : 'out-of-bounds' })
      if (gx < 0 || gx >= cols || gy < 0 || gy >= rows) return false
      if (grid[gy][gx] !== null) return false
    }
    return true
  }

  function setPiece(on: boolean) {
    const cellsDef = current.s.rots[current.rot % 4]
    for (const c of cellsDef) {
      const gx = current.x + c.x
      const gy = current.y + c.y
      if (gy >= 0 && gy < rows && gx >= 0 && gx < cols) {
        grid[gy][gx] = on ? current.s.color : null
        redrawCell(gx, gy)
      }
    }
  }

  function lockPiece() {
    clearLines()
    current = spawnPiece()
    if (!validAt(current.x, current.y, current.rot)) {
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { grid[y][x] = null; redrawCell(x, y) }
    }
  }

  function clearLines() {
    for (let y = rows - 1; y >= 0; y--) {
      if (grid[y].every(v => v !== null)) {
        for (let yy = y; yy > 0; yy--) {
          for (let x = 0; x < cols; x++) grid[yy][x] = grid[yy - 1][x]
        }
        for (let x = 0; x < cols; x++) grid[0][x] = null
        redrawAll()
        y++
      }
    }
  }

  scene.time.addEvent({ delay: 16, loop: true, callback: () => { moveCooldown = Math.max(0, moveCooldown - 16) } })

  // Arrow-only controls: ← → move, ↑ rotate
  scene.time.addEvent({ delay: 50, loop: true, callback: () => {
    const left = ctx.keys.left
    const right = ctx.keys.right
    const rotate = ctx.keys.up
    
    // Debug key states
    if (left || right || rotate) {
      console.log('🎮 TETRIS KEYS:', { left, right, rotate, cooldown: moveCooldown })
    }

    if (moveCooldown === 0) {
      if (left) {
        setPiece(false) // Remove piece first
        const canMove = validAt(current.x - 1, current.y, current.rot)
        console.log('🎮 LEFT:', { canMove, currentX: current.x, newX: current.x - 1 })
        if (canMove) { 
          console.log('🎮 MOVING LEFT')
          current.x -= 1
          setPiece(true)
          moveCooldown = 120 
        } else {
          setPiece(true) // Put piece back if can't move
        }
      }
      else if (right) {
        setPiece(false) // Remove piece first
        const canMove = validAt(current.x + 1, current.y, current.rot)
        console.log('🎮 RIGHT:', { canMove, currentX: current.x, newX: current.x + 1 })
        if (canMove) { 
          console.log('🎮 MOVING RIGHT')
          current.x += 1
          setPiece(true)
          moveCooldown = 120 
        } else {
          setPiece(true) // Put piece back if can't move
        }
      }
      else if (rotate) {
        setPiece(false) // Remove piece first
        const canRotate = validAt(current.x, current.y, current.rot + 1)
        console.log('🎮 ROTATE:', { canRotate, currentRot: current.rot, newRot: (current.rot + 1) % 4 })
        if (canRotate) { 
          console.log('🎮 ROTATING')
          current.rot = (current.rot + 1) % 4
          setPiece(true)
          moveCooldown = 150 
        } else {
          setPiece(true) // Put piece back if can't rotate
        }
      }
    }
  } })

  scene.time.addEvent({ delay: 16, loop: true, callback: () => {
    // Use faster drop speed when down arrow is held
    const currentDropMs = ctx.keys.down ? Math.max(16, Math.floor(dropMs / 8)) : dropMs
    
    if (!scene.data.get('tetrisDropTimer')) scene.data.set('tetrisDropTimer', currentDropMs)
    const t = (scene.data.get('tetrisDropTimer') as number) - 16
    if (t > 0) { scene.data.set('tetrisDropTimer', t); return }
    scene.data.set('tetrisDropTimer', currentDropMs)

    setPiece(false)
    if (validAt(current.x, current.y + 1, current.rot)) {
      current.y += 1
      setPiece(true)
    } else {
      setPiece(true)
      lockPiece()
    }
  } })

  setPiece(true)
  console.debug('[tetris] Tetris game fully initialized, piece placed')
}
