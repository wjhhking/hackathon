// src/debug/DebugLoopController.ts
import { EventEmitter } from "node:events";
import * as path from "node:path";
import type { ChatCompletion } from "openai/resources";
import * as vscode from "vscode";
import { AIChat, callLlm } from "../ai/Chat";
import {
  allFunctions,
  getExceptionMessage,
  getInitialBreakpointsMessage,
  getPausedMessage,
  systemMessage,
} from "../ai/prompts";
import { SourceCodeCollector } from "../context/SourceCodeCollector";
import logger from "../logger";
import { DebugState, PausedState } from "./DebugState";

const log = logger.createSubLogger("DebugLoopController");

/**
 * This controller waits for "stopped" events to retrieve paused state.
 * Instead of forcing "pause", we only call gatherPausedState after the debugger
 * actually stops. This avoids the 'Thread is not paused' error.
 */
export class DebugLoopController extends EventEmitter {
  private live = false;
  private finished = false; // Add a flag to track if finish has been called
  private session: vscode.DebugSession | null = null;
  private previousBreakpoints: vscode.Breakpoint[] = [];
  private threadId: number | undefined;

  constructor(private sourceCodeCollector: SourceCodeCollector) {
    super();
  }

  private chat = new AIChat(systemMessage, allFunctions);

  setWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder) {
    this.sourceCodeCollector.setWorkspaceFolder(workspaceFolder);
  }

  setSession(session: vscode.DebugSession) {
    this.session = session;
  }

  setThreadId(threadId: number | undefined) {
    this.threadId = threadId;
  }

  async shouldLoop() {
    if (!this.session || !this.live) {
      return false;
    }

    // If we already have a threadId, use it
    if (this.threadId) {
      return true;
    }

    // Otherwise try to get thread info
    try {
      const threadsResponse = await this.session.customRequest("threads");
      const threads = threadsResponse?.threads || [];
      if (threads.length > 0) {
        this.threadId = threads[0].id;
        return true;
      }
    } catch (err) {
      log.error("Error getting threads:", String(err));
    }

    log.error("No threads found in session");
    return false;
  }

  async handleException(session: vscode.DebugSession, stderr: string, stdout: string) {
    log.debug("Handling exception...");

    if (session !== this.session) return;
    log.debug("Gathering paused state");
    const debugState = new DebugState();
    let pausedState: PausedState | undefined;
    try {
      pausedState = await debugState.gatherPausedState(this.session!);
    } catch (error) {
      log.error("Error gathering paused state", String(error));
      // If we fail to get the paused state (most probably because program already exited) we make an empty state to continue
      pausedState = {
        breakpoints: [],
        pausedStack: [],
        topFrameVariables: [],
      }
    }

    // checking again since while we were gathering paused state, the live flag could have been set to false
    const shouldLoop = await this.shouldLoop();
    if (!shouldLoop) return;

    log.debug("Thinking..");
    this.emit("spinner", { active: true, message: "Handling exception" });

    const messageToSend = getExceptionMessage(this.sourceCodeCollector.gatherWorkspaceCode(), pausedState, stderr, stdout);
    log.debug("Message to LLM:", messageToSend);

    const llmResponse = await this.chat.ask(messageToSend, { withFunctions: false });
    this.emit("spinner", { active: false });
    if (!this.live) return;

    const [choice] = llmResponse.choices;
    const content = choice?.message?.content;
    if (content) {
      log.info(content);
      this.emit("debugResults", { results: content });
    } else {
      log.info("No content from LLM");
    }
    this.emit('isInSession', { isInSession: false });
    this.stop();
  }

  waitForThreadStopped() {
    log.debug("Waiting for thread to stop...");
    return new Promise<void>((resolve) => {
      this.once("threadStopped", resolve);
    });
  }

  async setInitialBreakpoints(removeExisting = true) {
    log.debug("Setting initial breakpoints");
    if (removeExisting) {
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      this.previousBreakpoints = [];
    }
    this.emit("spinner", { active: true, message: "Setting initial breakpoints" });
    const structuredCode = this.sourceCodeCollector.gatherWorkspaceCode();
    const response = await callLlm(
      getInitialBreakpointsMessage(structuredCode),
      allFunctions
    );

    await this.handleLlmFunctionCall(response);
    this.emit("spinner", { active: false });
  }

  reset() {
    this.session = null;
    this.threadId = undefined;
    this.chat.clearHistory();
    this.live = false;
    this.finished = false; // Reset the finished flag
  }

  async loop() {
    if (!await this.shouldLoop()) return;

    log.debug("Gathering paused state");
    const debugState = new DebugState();
    const pausedState = await debugState.gatherPausedState(this.session!);

    if (!await this.shouldLoop()) return;

    log.debug("Thinking..");
    this.emit("spinner", { active: true, message: "Deciding the next step to take..." });
    const messageToSend = getPausedMessage(this.sourceCodeCollector.gatherWorkspaceCode(), pausedState);
    log.trace("Message to LLM:", messageToSend);

    const llmResponse = await this.chat.ask(messageToSend);
    
    if (!this.live) return;
    this.emit("spinner", { active: false });

    const [choice] = llmResponse.choices;
    const content = choice?.message?.content;
    if (content) {
      log.info(content);
    }

    await this.handleLlmFunctionCall(llmResponse, true);
  }

  async clear() {
    this.emit("spinner", { active: false });
    this.emit("debugResults", { results: null });
  }

  async start() {
    log.debug("Starting debug loop controller");
    this.live = true;
    this.emit("isInSession", { isInSession: true });
    await this.setInitialBreakpoints();
    log.debug('Initial breakpoints are set')
    this.session?.customRequest('continue')
  }


  async finish(exitReason?: string) {
    if (this.finished) {
      return; // Prevent multiple calls
    }
    this.stop();
    this.finished = true;

    log.debug("Debug session finished. Providing code fix and explanation");
    this.emit("spinner", {
      active: true,
      message: "Debug session finished. Providing code fix and explaination",
    });

    try {
      let finalPrompt = "Debug session finished. Provide a code fix and explain your reasoning.";
      if (exitReason) {
        finalPrompt = `${exitReason}\n\n${finalPrompt}`;
      }

      const response = await this.chat.ask(finalPrompt, { withFunctions: false });
      const [choice] = response.choices;
      const content = choice?.message?.content;
      if (content) {
        log.info(content);
        this.emit("debugResults", { results: content });
      } else {
        log.info("No content from LLM");
      }
    } catch (error) {
      log.error("Error during final LLM call:", String(error));
      this.emit("debugResults", { results: `An error occurred while generating the final report: ${String(error)}` }); // Show error to the user!
    } finally {
      this.emit("spinner", { active: false });
      this.emit('isInSession', { isInSession: false });
      this.stop();
    }
  }


  stop() {
    this.live = false;
  }

  async setBreakpoint(functionArgsString: string) {
    try {
      const { file, line } = JSON.parse(functionArgsString);
      let fullPath = file;
      if (!path.isAbsolute(file) && vscode.workspace.workspaceFolders?.length) {
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        fullPath = path.join(workspaceRoot, file);
      }

      const uri = vscode.Uri.file(fullPath);
      const position = new vscode.Position(line - 1, 0);
      const location = new vscode.Location(uri, position);
      const breakpoint = new vscode.SourceBreakpoint(location, true);

      // Remove existing breakpoints before adding a new one
      vscode.debug.removeBreakpoints(this.previousBreakpoints);
      vscode.debug.addBreakpoints([breakpoint]);
      this.previousBreakpoints = [breakpoint]; // Store the new breakpoint

      log.debug(`Set breakpoint at ${fullPath}:${line}`);

    } catch (err) {
      log.error(`Failed to set breakpoint: ${String(err)}`);
      vscode.window.showErrorMessage(
        `Failed to set breakpoint: ${String(err)}`,
      );
    }
  }

  async removeBreakpoint(functionArgsString: string) {
    log.debug(`Removing breakpoint: ${functionArgsString}`);
    try {
      const { file, line } = JSON.parse(functionArgsString);
      const allBreakpoints = vscode.debug.breakpoints;
      const toRemove: vscode.Breakpoint[] = [];

      for (const bp of allBreakpoints) {
        if (bp instanceof vscode.SourceBreakpoint) {
          const thisFile = bp.location.uri.fsPath;
          const thisLine = bp.location.range.start.line + 1;
          if (
            (thisFile === file || thisFile.endsWith(file)) &&
            thisLine === line
          ) {
            toRemove.push(bp);
          }
        }
      }

      if (toRemove.length) {
        vscode.debug.removeBreakpoints(toRemove);
        log.debug(
          `Removed ${toRemove.length} breakpoint(s) at ${file}:${line}`,
        );
      }
    } catch (err) {
      log.error(`Failed to remove breakpoint: ${String(err)}`);
      vscode.window.showErrorMessage(
        `Failed to remove breakpoint: ${String(err)}`,
      );
    }
  }

  async next() {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      log.debug("Cannot run command 'next'. No active debug session.");
      return;
    }
    try {
      const threads = await session.customRequest("threads");
      const threadId = threads.threads[0]?.id;
      if (threadId === undefined) {
        log.debug("Cannot run command 'next'. No active thread found.");
        return;
      }
      await session.customRequest("next", { threadId });
      await this.waitForThreadStopped();
    } catch (err) {
      log.error(`Failed to run command 'next': ${String(err)}`);
    }
  }

  async stepIn() {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      log.debug("Cannot stepIn. No active debug session.");
      return;
    }
    try {
      const threads = await session.customRequest("threads");
      const threadId = threads.threads[0]?.id;
      if (threadId === undefined) {
        log.debug("Cannot stepIn. No active thread found.");
        return;
      }
      await session.customRequest("stepIn", { threadId }); // Await directly
      await this.waitForThreadStopped();  // Then wait.
    } catch (err) {
      log.error(`Failed to step in: ${String(err)}`);
    }
  }

  async stepOut() {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      log.debug("Cannot run command 'stepOut'. No active debug session.");
      return;
    }
    try {
      const threads = await session.customRequest("threads");
      const threadId = threads.threads[0]?.id;
      if (threadId === undefined) {
        log.debug("Cannot run command 'stepOut'. No active thread found.");
        return;
      }
      await session.customRequest("stepOut", { threadId });  // Await the request
      await this.waitForThreadStopped(); // Then wait for the stopped event
      log.info("Stepped out of the current function call.");
    } catch (err) {
      log.error(`Failed to run command 'stepOut': ${String(err)}`);
    }
  }

  async continueExecution() {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      log.debug("Cannot run command 'continue'. No active debug session.");
      return;
    }
    try {
      const threads = await session.customRequest("threads");
      const threadId = threads.threads[0]?.id;
      if (threadId === undefined) {
        log.debug("Cannot run command 'continue'. No active thread found.");
        return;
      }
      await session.customRequest("continue", { threadId }); // Await directly
      await this.waitForThreadStopped(); // Then wait.
    } catch (err) {
      log.error(`Failed to run command 'continue': ${String(err)}`);
    }
  }

  async handleLlmFunctionCall(completion: ChatCompletion, continueAfterSettingBreakpoint = false) {
    const choice = completion?.choices?.[0];
    if (!choice) {
      log.debug(`No choice found in completion. ${JSON.stringify(completion)}`);
      return;
    }

    const hasActiveBreakpoints = vscode.debug.breakpoints.some(
      (bp) => bp.enabled,
    );

    log.debug(`Handling LLM function call: ${JSON.stringify({ choice, hasActiveBreakpoints })}`);

    for (const toolCall of choice.message?.tool_calls || []) {
      const { name, arguments: argsStr } = toolCall.function;
      log.debug(`${name}(${argsStr && argsStr !== '{}' ? argsStr : ""})`);

      const parsedArgs = argsStr ? JSON.parse(argsStr) : {};
      const { reason, ...args } = parsedArgs;

      this.emit('aiFunctionCall', { functionName: name, args, reason });

      switch (name) {
        case "setBreakpoint":
          await this.setBreakpoint(argsStr);
          if (continueAfterSettingBreakpoint) {
            await this.session?.customRequest('continue');
          }
          break;
        case "removeBreakpoint":
          await this.removeBreakpoint(argsStr);
          break;
        case "next":
          await this.next();
          break;
        case "stepIn":
          await this.stepIn();
          break;
        case "stepOut":
          await this.stepOut();
          break;
        case "continue": {
          if (hasActiveBreakpoints) {
            await this.continueExecution();
          } else {
            log.debug("Cannot continue. No active breakpoints.");
          }
          break;
        }
        default:
          break;
      }
    }
  }
}