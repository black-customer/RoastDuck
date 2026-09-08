package com.roastduck.app;

import android.net.Uri;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.util.Set;
import java.util.concurrent.*;

@CapacitorPlugin(name = "RoastDuckRuntime")
public class RuntimePlugin extends Plugin {
    private RuntimeReceiptStore store;
    private SecretVault vault;
    private final RuntimeHttp http = new RuntimeHttp();
    private final Set<String> active = ConcurrentHashMap.newKeySet();
    private final ExecutorService interactive = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(8));
    private final ExecutorService background = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(8));
    private final ExecutorService receipts = Executors.newSingleThreadExecutor();
    private volatile boolean stopped;
    @Override public void load() {
        vault = new SecretVault(getContext());
        try { store = new RuntimeReceiptStore(getContext()); } catch (Exception ignored) { store = null; }
    }
    private void local(PluginCall call, Runnable operation) {
        if (getActivity() == null || stopped) { call.reject("页面已关闭", "activity_unavailable"); return; }
        getActivity().runOnUiThread(() -> {
            if (stopped || getActivity() == null || getActivity().isFinishing() || getActivity().isDestroyed()) { call.reject("页面已关闭", "activity_unavailable"); return; }
            String url = getBridge().getWebView() == null ? null : getBridge().getWebView().getUrl();
            Uri uri = url == null ? null : Uri.parse(url);
            if (store == null || uri == null || !"https".equals(uri.getScheme()) || !"localhost".equals(uri.getHost()) || uri.getPort() != -1) { call.reject("仅本机应用可调用服务", "untrusted_origin"); return; }
            operation.run();
        });
    }
    private String id(PluginCall call) {
        String value = call.getString("runId", "");
        if (!value.matches("[A-Za-z0-9_-]{1,160}")) { call.reject("请求编号无效", "invalid_request"); return null; }
        return value;
    }
    private JSObject project(JSONObject receipt, String runId) throws Exception {
        JSObject output = new JSObject();
        if (receipt == null) { output.put("state", "unknown"); return output; }
        String state = receipt.optString("state", "unknown");
        if ("pending".equals(state) && !active.contains(runId)) state = "unknown";
        output.put("state", state); output.put("httpStatus", receipt.optInt("httpStatus", 0));
        if (receipt.has("body")) output.put("body", receipt.getString("body"));
        return output;
    }
    @PluginMethod public void lookup(PluginCall call) { local(call, () -> {
        String runId = id(call); if (runId == null) return;
        try { receipts.execute(() -> { try { call.resolve(project(store.read(runId), runId)); } catch (Exception error) { call.reject("请求回执暂时无法读取", "receipt_unavailable"); } }); }
        catch (RejectedExecutionException error) { call.reject("服务忙，请稍后恢复", "request_pending"); }
    }); }
    @PluginMethod public void request(PluginCall call) { local(call, () -> {
        String runId = id(call); if (runId == null) return;
        String body = call.getString("body", "");
        try { RuntimeHttp.validate(body); } catch (Exception error) { call.reject("请求不符合固定模型文本契约", "invalid_request"); return; }
        boolean foreground = false;
        try { String name = new JSONObject(body).getJSONObject("text").getJSONObject("format").optString("name"); foreground = name.startsWith("companion_dialogue") || name.startsWith("four_step_judge") || name.startsWith("gap_retrieval_judge"); } catch (Exception ignored) { /* Non-interactive jobs use their own bounded lane. */ }
        try { (foreground ? interactive : background).execute(() -> execute(call, runId, body)); }
        catch (RejectedExecutionException error) { call.reject("服务忙，请稍后恢复", "request_pending"); }
    }); }
    private void execute(PluginCall call, String runId, String body) {
        boolean claimed = false, recorded = false;
        try {
            String key = vault.read("deepseek");
            if (key == null || key.isEmpty()) { call.reject("请在设置中配置自己的DeepSeek Key", "missing_key"); return; }
            synchronized (store) {
                JSONObject prior = store.begin(runId, RuntimeReceiptStore.hash(body));
                if (prior != null) { call.resolve(project(prior, runId)); return; }
                active.add(runId); claimed = true;
            }
            RuntimeHttp.Result result = http.post(key, body);
            store.finish(runId, result.status >= 200 && result.status < 300 ? "completed" : "failed", result.status, result.body);
            recorded = true;
            call.resolve(project(store.read(runId), runId));
        } catch (Exception error) {
            if (claimed && !recorded) try { store.finish(runId, "unknown", 0, null); } catch (Exception ignored) { /* Pending receipt remains conservative. */ }
            call.reject(claimed ? "请求中断，结果需恢复确认" : "请求未发出，请检查本地存储", claimed ? "result_unknown" : "receipt_unavailable");
        } finally { if (claimed) active.remove(runId); }
    }
    @Override protected void handleOnDestroy() { stopped = true; interactive.shutdown(); background.shutdown(); receipts.shutdown(); }
}
