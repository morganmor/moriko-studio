/**
 * callAgentTool() — routes one `agent__*` wire call to its handler; never throws.
 *
 * The tool implementations live in the sibling modules; this file is the
 * single dispatch point the loop (mcp/loop.ts) and routes.ts call into.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { runPipeline, type PipelineCall } from '../pipeline.js';
import { getAddonToolHandler } from '../../addons/registry.js';

import { listTool } from './list.js';
import { grepTool } from './grep.js';
import { readAllTool, readFileTool } from './read.js';
import { editDefaultTool } from './edit-default.js';
import { multiEditTool } from './multi-edit.js';
import { editLinesTool } from './edit-lines.js';
import { editBetweenTool } from './edit-between.js';
import { insertAtLineTool } from './insertAtLine.js';
import { writeTool } from './write.js';
import { renameTool, moveTool, copyTool, deleteTool } from './transfer.js';
import { goalCreateTool, goalUpdateTool, goalListTool } from './goals.js';
import { fetchTool, downloadTool } from './net.js';
import { vaultListTool, vaultRestoreTool } from './vault.js';
import { runTool, gitTool } from './terminal.js';
import { askUserTool } from './ask.js';
import { addonManageTool } from './addonManage.js';
import { hashTool, remindTool, depsTool } from './deps-meta.js';
import { explainErrorTool } from './explain-error.js';
import { visionTool, visionStatusTool } from './vision.js';
import { searchTool } from './search.js';
import { batchReadTool } from './batch-read.js';
import { checkpointTool, undoTool, checkpointListTool } from './checkpoint.js';
import { applyPatchTool } from './patch.js';
import { globTool } from './glob.js';
import { typecheckTool } from './typecheck.js';
import { testRunTool } from './test-run.js';
import { spatialTool } from './spatial.js';
import { layoutEditTool } from './layout-edit.js';
import { backendTool } from './backend.js';
import { taskStartTool, taskOutputTool, taskStopTool } from './bg-task.js';
import { lspSymbolsTool } from './lsp.js';
import { treeOutlineTool, treeRefreshTool } from './tree.js';
import { renderVisualTool } from './visual.js';
import { execTool } from './exec.js';
import { browserOpenTool, browserReadTool, browserScreenshotTool, browserWaitTool, browserEvalTool, browserUrlTool, browserClickTool, browserTypeTool, browserCursorMoveTool, browserScrollTool, browserHandoverTool, browserReleaseTool, browserTabsTool, browserSwitchTabTool, browserCloseTabTool, browserClearDataTool, browserDragTool, browserMouseDownTool, browserMouseUpTool, browserHoverTool, browserPressTool, browserBackTool, browserForwardTool, browserReloadTool, browserInspectTool, browserSemanticTool, browserFormTool, browserReadArticleTool, browserWatchTool, browserWatchResultTool, browserMetadataTool, browserSavePageTool, browserSaveImagesTool, browserUploadTool, browserDownloadTool, browserTableTool, browserPdfTool, browserCrawlTool, browserBlockRequestsTool, browserUnblockRequestsTool, browserAuditLogTool, browserRequestApprovalTool, browserPlanTool, browserDebugTool, browserInstallScriptTool, browserListScriptsTool, browserRemoveScriptTool, browserBaselineTool, browserVisualDiffTool, browserMergeTabsTool, browserFanOutTool, browserMarkTool, browserMarksTool, browserRecordTool, browserReplayTool, browserTouchTapTool, browserDialogTool, browserAnnotationsTool } from './browser.js';
import { harnessLockdownTool, harnessChoiceTool } from './lockdown.js';
import { isWebTool } from './web-access.js';
import { harnessReloadNow } from '../reload.js';

/** Routes one `agent__*` wire call to its handler; never throws.
 *  The call goes through the tool pipeline (schema validation, audit) first —
 *  see pipeline.ts — so the switch below only sees well-formed calls. */
export async function callAgentTool(
  wireName: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext = {},
): Promise<HarnessToolResult> {
  const name = wireName.replace(/^agent__/, '');
  // WEB ACCESS KILL-SWITCH — belt-and-suspenders behind the catalogue gate:
  // catalogue filtering already hides these tools, but NESTED agent__exec calls
  // and stale-catalogue recall must hit this hard refusal instead of the web.
  if (ctx.webAccess === false && isWebTool(wireName)) {
    return {
      ok: false,
      isError: true,
      errorCode: 'web_access_off',
      text:
        'Web access is OFF — the user disabled it for this conversation (Configuration → Tools → Web Access). ' +
        'Do not attempt browser, fetch or download tools; ask the user to enable Web Access if the task truly needs the web.',
    };
  }
  const execute = async (call: PipelineCall): Promise<HarnessToolResult> => {
    const callArgs = call.args;
    // VISUAL v2 — fail-fast shape contract BEFORE the pipeline runs: an id
    // that is not a string can never resolve, and a bad id must be refused
    // here (a tool_exception would hide the exact cause from the model).
    if (call.name === 'render_visual') {
      const id = callArgs['id'];
      if (id !== undefined && (typeof id !== 'string' || id.trim().length === 0 || id.trim().length > 200)) {
        return {
          ok: false,
          isError: true,
          errorCode: 'schema_error',
          text: 'render_visual "id" must be a non-empty visual id string (as returned by a previous render summary).',
        };
      }
      const variants = callArgs['variants'];
      if (variants !== undefined && !Array.isArray(variants)) {
        return {
          ok: false,
          isError: true,
          errorCode: 'schema_error',
          text: 'render_visual "variants" must be an array of 1..3 candidate documents [{ source, title?, height? }].',
        };
      }
    }
    const callCtx = call.ctx;
    switch (call.name) {
      case 'list':
        return await listTool(callArgs, callCtx);
      case 'grep':
        return await grepTool(callArgs, callCtx);
      case 'read_all':
        return await readAllTool(callArgs, callCtx);
      case 'read_file':
        return await readFileTool(callArgs, callCtx);
      case 'edit_file':
        return await editDefaultTool(callArgs, callCtx);
      case 'write':
        return await writeTool(callArgs, callCtx);
      case 'multi_edit':
        return await multiEditTool(callArgs, callCtx);
      case 'edit_lines':
        return await editLinesTool(callArgs, callCtx);
      case 'edit_between':
        return await editBetweenTool(callArgs, callCtx);
      case 'insert_at_line':
        return await insertAtLineTool(callArgs, callCtx);
      case 'rename':
        return await renameTool(callArgs, callCtx);
      case 'move':
        return await moveTool(callArgs, callCtx);
      case 'copy':
        return await copyTool(callArgs, callCtx);
      case 'delete':
        return await deleteTool(callArgs, callCtx);
      case 'goal_create':
        return await goalCreateTool(callArgs, callCtx);
      case 'goal_update':
        return await goalUpdateTool(callArgs, callCtx);
      case 'goal_list':
        return await goalListTool(callArgs, callCtx);
      case 'fetch':
        return await fetchTool(callArgs, callCtx);
      case 'download':
        return await downloadTool(callArgs, callCtx);
      case 'vault_list':
        return await vaultListTool(callArgs, callCtx);
      case 'vault_restore':
        return await vaultRestoreTool(callArgs, callCtx);
      case 'run':
        return await runTool(callArgs, callCtx);
      case 'git':
        return await gitTool(callArgs, callCtx);
      case 'hash':
        return hashTool(callArgs);
      case 'remind':
        return await remindTool(callArgs, callCtx);
      case 'harness_reload':
        return await harnessReloadNow().then((result) => ({ ok: result.ok, isError: !result.ok, text: result.text }));
      case 'vision':
        return await visionTool(callArgs, callCtx);
      case 'vision_status':
        return await visionStatusTool(callArgs, callCtx);
      case 'explain_error':
        return await explainErrorTool(callArgs, callCtx);
      case 'search':
        return searchTool(callArgs, callCtx);
      case 'batch_read':
        return await batchReadTool(callArgs, callCtx);
      case 'checkpoint':
        return await checkpointTool(callArgs, callCtx);
      case 'undo':
        return await undoTool(callArgs, callCtx);
      case 'checkpoint_list':
        return await checkpointListTool(callArgs, callCtx);
      case 'apply_patch':
        return await applyPatchTool(callArgs, callCtx);
      case 'deps':
        return depsTool(callArgs, callCtx);
      case 'glob':
        return await globTool(callArgs, callCtx);
      case 'typecheck':
        return await typecheckTool(callArgs, callCtx);
      case 'test_run':
        return await testRunTool(callArgs, callCtx);
      case 'spatial':
        return await spatialTool(callArgs, callCtx);
      case 'layout_edit':
        return await layoutEditTool(callArgs, callCtx);
      case 'backend':
        return await backendTool(callArgs, callCtx);
      case 'task_start':
        return await taskStartTool(callArgs, callCtx);
      case 'task_output':
        return await taskOutputTool(callArgs, callCtx);
      case 'task_stop':
        return await taskStopTool(callArgs, callCtx);
      case 'lsp_symbols':
        return await lspSymbolsTool(callArgs, callCtx);
      case 'tree_outline':
        return treeOutlineTool(callArgs, callCtx);
      case 'tree_refresh':
        return await treeRefreshTool(callArgs, callCtx);
      case 'render_visual':
        return renderVisualTool(callArgs, callCtx);
      case 'exec':
        return await execTool(callArgs, callCtx);
      case 'browser_open':
        return await browserOpenTool(callArgs, callCtx);
      case 'browser_read':
        return await browserReadTool(callArgs, callCtx);
      case 'browser_screenshot':
        return await browserScreenshotTool(callArgs, callCtx);
      case 'browser_wait':
        return await browserWaitTool(callArgs, callCtx);
      case 'browser_eval':
        return await browserEvalTool(callArgs, callCtx);
      case 'browser_url':
        return await browserUrlTool(callArgs, callCtx);
      case 'browser_click':
        return await browserClickTool(callArgs, callCtx);
      case 'browser_type':
        return await browserTypeTool(callArgs, callCtx);
      case 'browser_cursor_move':
        return await browserCursorMoveTool(callArgs, callCtx);
      case 'browser_scroll':
        return await browserScrollTool(callArgs, callCtx);
      case 'browser_handover':
        return await browserHandoverTool(callArgs, callCtx);
      case 'browser_release':
        return await browserReleaseTool(callArgs, callCtx);
      case 'browser_tabs':
        return await browserTabsTool(callArgs, callCtx);
      case 'browser_switch_tab':
        return await browserSwitchTabTool(callArgs, callCtx);
      case 'browser_close_tab':
        return await browserCloseTabTool(callArgs, callCtx);
      case 'browser_clear_data':
        return await browserClearDataTool(callArgs, callCtx);
      case 'browser_drag':
        return await browserDragTool(callArgs, callCtx);
      case 'browser_mouse_down':
        return await browserMouseDownTool(callArgs, callCtx);
      case 'browser_mouse_up':
        return await browserMouseUpTool(callArgs, callCtx);
      case 'browser_hover':
        return await browserHoverTool(callArgs, callCtx);
      case 'browser_press':
        return await browserPressTool(callArgs, callCtx);
      case 'browser_back':
        return await browserBackTool(callArgs, callCtx);
      case 'browser_forward':
        return await browserForwardTool(callArgs, callCtx);
      case 'browser_reload':
        return await browserReloadTool(callArgs, callCtx);
      case 'browser_inspect':
        return await browserInspectTool(callArgs, callCtx);
      case 'browser_semantic':
        return await browserSemanticTool(callArgs, callCtx);
      case 'browser_form':
        return await browserFormTool(callArgs, callCtx);
      case 'browser_read_article':
        return await browserReadArticleTool(callArgs, callCtx);
      case 'browser_watch':
        return await browserWatchTool(callArgs, callCtx);
      case 'browser_watch_result':
        return await browserWatchResultTool(callArgs, callCtx);
      case 'browser_metadata':
        return await browserMetadataTool(callArgs, callCtx);
      case 'browser_save_page':
        return await browserSavePageTool(callArgs, callCtx);
      case 'browser_save_images':
        return await browserSaveImagesTool(callArgs, callCtx);
      case 'browser_upload':
        return await browserUploadTool(callArgs, callCtx);
      case 'browser_download':
        return await browserDownloadTool(callArgs, callCtx);
      case 'browser_table':
        return await browserTableTool(callArgs, callCtx);
      case 'browser_pdf':
        return await browserPdfTool(callArgs, callCtx);
      case 'browser_crawl':
        return await browserCrawlTool(callArgs, callCtx);
      case 'browser_block_requests':
        return await browserBlockRequestsTool(callArgs, callCtx);
      case 'browser_unblock_requests':
        return await browserUnblockRequestsTool(callArgs, callCtx);
      case 'browser_audit_log':
        return await browserAuditLogTool(callArgs, callCtx);
      case 'browser_request_approval':
        return await browserRequestApprovalTool(callArgs, callCtx);
      case 'browser_plan':
        return await browserPlanTool(callArgs, callCtx);
      case 'browser_debug':
        return await browserDebugTool(callArgs, callCtx);
      case 'browser_install_script':
        return await browserInstallScriptTool(callArgs, callCtx);
      case 'browser_list_scripts':
        return await browserListScriptsTool(callArgs, callCtx);
      case 'browser_remove_script':
        return await browserRemoveScriptTool(callArgs, callCtx);
      case 'browser_baseline':
        return await browserBaselineTool(callArgs, callCtx);
      case 'browser_visual_diff':
        return await browserVisualDiffTool(callArgs, callCtx);
      case 'browser_merge_tabs':
        return await browserMergeTabsTool(callArgs, callCtx);
      case 'browser_fan_out':
        return await browserFanOutTool(callArgs, callCtx);
      case 'browser_mark':
        return await browserMarkTool(callArgs, callCtx);
      case 'browser_marks':
        return await browserMarksTool(callArgs, callCtx);
      case 'browser_record':
        return await browserRecordTool(callArgs, callCtx);
      case 'browser_replay':
        return await browserReplayTool(callArgs, callCtx);
      case 'browser_touch_tap':
        return await browserTouchTapTool(callArgs, callCtx);
      case 'browser_dialog':
        return await browserDialogTool(callArgs, callCtx);
      case 'browser_annotations':
        return await browserAnnotationsTool(callArgs, callCtx);
      case 'ask_user':
        return await askUserTool(callArgs, callCtx);
      case 'harness_lockdown':
        return await harnessLockdownTool(callArgs, callCtx);
      case 'harness_choice':
        return await harnessChoiceTool(callArgs, callCtx);
      case 'addon_manage':
        return await addonManageTool(callArgs as unknown as import('./addonManage.js').AddonManageArgs);
      default: {
        // FASE 5 — addon tools: route to the addon handler if registered.
        const addonHandler = getAddonToolHandler(call.wireName);
        if (addonHandler) {
          return await runPipeline(
            async (c: PipelineCall) => addonHandler(c.args, c.ctx),
            { wireName: call.wireName, name: call.name, args: call.args, ctx: call.ctx },
          );
        }
        return {
          ok: false,
          isError: true,
          text:
            `Unknown agent tool "${call.wireName}". Available: agent__list, agent__grep, agent__read_file, agent__read_all, agent__edit_file, agent__write, agent__multi_edit, agent__edit_lines, agent__edit_between, agent__insert_at_line, ` +
            'agent__rename, agent__move, agent__copy, agent__delete, agent__goal_create, agent__goal_update, agent__goal_list, ' +
            'agent__fetch, agent__download, agent__vault_list, agent__vault_restore, agent__run, agent__git, ' +
            'agent__remind, agent__harness_reload, agent__vision, agent__vision_status, ' +
            'agent__explain_error, agent__search, agent__batch_read, agent__checkpoint, agent__undo, ' +
            'agent__checkpoint_list, agent__apply_patch, agent__deps, agent__glob, ' +
            'agent__typecheck, agent__test_run, agent__spatial, agent__layout_edit, agent__backend, agent__task_start, agent__task_output, agent__task_stop, ' +
            'agent__lsp_symbols, agent__ask_user, agent__tree_outline, agent__tree_refresh, agent__render_visual, agent__exec, ' +
            'agent__browser_open, agent__browser_read, agent__browser_screenshot, agent__browser_wait, agent__browser_eval, agent__browser_url, ' +
            'agent__browser_click, agent__browser_type, agent__browser_cursor_move, agent__browser_scroll, ' +
            'agent__browser_handover, agent__browser_release, agent__browser_tabs, agent__browser_switch_tab, agent__browser_close_tab, agent__browser_clear_data, '
            + 'agent__browser_drag, agent__browser_mouse_down, agent__browser_mouse_up, agent__browser_hover, agent__browser_press, '
            + 'agent__browser_back, agent__browser_forward, agent__browser_reload, '
            + 'agent__browser_inspect, agent__browser_semantic, agent__browser_form, agent__browser_read_article, '
            + 'agent__browser_watch, agent__browser_watch_result, agent__browser_metadata, '
            + 'agent__browser_save_page, agent__browser_save_images, agent__browser_upload, agent__browser_download, '
            + 'agent__browser_table, agent__browser_pdf, agent__browser_crawl, '
            + 'agent__browser_block_requests, agent__browser_unblock_requests, agent__browser_audit_log, '
            + 'agent__browser_request_approval, agent__browser_plan, '
            + 'agent__browser_debug, agent__browser_install_script, agent__browser_list_scripts, agent__browser_remove_script, '
            + 'agent__browser_baseline, agent__browser_visual_diff, agent__browser_merge_tabs, agent__browser_fan_out, '
            + 'agent__browser_mark, agent__browser_marks, agent__browser_record, agent__browser_replay.'
        };
      }
    }
  };
  try {
    return await runPipeline(execute, { wireName, name, args, ctx });
  } catch (error) {
    // The pipeline converts errors to data; this only catches bugs in the
    return {
      ok: false,
      isError: true,
      text: error instanceof Error ? error.message : 'Agent tool dispatch failed.',
    };
  }
}
