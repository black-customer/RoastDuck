package com.roastduck.app;

import android.net.Uri;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import androidx.appcompat.app.AlertDialog;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "RoastDuckCredentials")
public class CredentialsPlugin extends Plugin {
    private SecretVault vault;
    private AlertDialog activeDialog;
    private PluginCall activeCall;
    private EditText secretInput;
    private boolean destroyed;

    @Override public void load() { vault = new SecretVault(getContext()); }
    private void onUi(PluginCall call, Runnable work) {
        androidx.appcompat.app.AppCompatActivity activity = getActivity();
        if (destroyed || activity == null) { call.reject("页面已关闭，请重新进入设置。", "activity_unavailable"); return; }
        activity.runOnUiThread(work);
    }
    private boolean localPage(PluginCall call) {
        if (destroyed || getActivity() == null || getActivity().isFinishing() || getActivity().isDestroyed()) {
            call.reject("页面已关闭，请重新进入设置。", "activity_unavailable"); return false;
        }
        String url = getBridge().getWebView() == null ? null : getBridge().getWebView().getUrl();
        Uri uri = url == null ? null : Uri.parse(url);
        if (uri == null || !"https".equals(uri.getScheme()) || !"localhost".equals(uri.getHost()) || uri.getPort() != -1) {
            call.reject("仅本机应用页面可以配置凭据。", "untrusted_origin"); return false;
        }
        return true;
    }
    private String provider(PluginCall call) {
        String value = call.getString("provider", "");
        if (!"deepseek".equals(value) && !"mimo".equals(value)) { call.reject("不支持的服务。", "invalid_provider"); return null; }
        return value;
    }
    private boolean beginDialog(PluginCall call) {
        if (!localPage(call)) return false;
        if (!getActivity().getLifecycle().getCurrentState().isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) {
            call.reject("应用已暂停，请回到设置后再试。", "app_paused"); return false;
        }
        if (activeCall != null) { call.reject("请先处理当前凭据窗口。", "credential_dialog_busy"); return false; }
        activeCall = call; return true;
    }
    private void finish(boolean changed, String failure) {
        PluginCall call = activeCall;
        activeCall = null;
        if (secretInput != null) { secretInput.setText(""); secretInput = null; }
        AlertDialog dialog = activeDialog; activeDialog = null;
        if (dialog != null) {
            dialog.setOnCancelListener(null); dialog.setOnDismissListener(null);
            try { dialog.dismiss(); } catch (RuntimeException ignored) { /* Activity may already have removed its window. */ }
        }
        if (call != null) {
            if (failure != null) call.reject(failure, "vault_unavailable");
            else { JSObject result = new JSObject(); result.put("changed", changed); call.resolve(result); }
        }
    }
    private void show(AlertDialog dialog) {
        activeDialog = dialog;
        dialog.setOnCancelListener(d -> finish(false, null));
        dialog.setOnDismissListener(d -> finish(false, null));
        dialog.show();
        if (dialog.getWindow() != null) dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }
    @Override protected void handleOnPause() { finish(false, null); }
    @Override protected void handleOnDestroy() { destroyed = true; finish(false, null); }

    @PluginMethod public void status(PluginCall call) {
        onUi(call, () -> {
            if (!localPage(call)) return;
            JSObject result = new JSObject();
            result.put("deepseek", vault.configured("deepseek")); result.put("mimo", vault.configured("mimo"));
            call.resolve(result);
        });
    }
    @PluginMethod public void configure(PluginCall call) {
        String selected = provider(call); if (selected == null) return;
        onUi(call, () -> {
            if (!beginDialog(call)) return;
            try {
                EditText input = new EditText(getActivity()); secretInput = input;
                input.setSingleLine(true);
                input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
                input.setImeOptions(EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING | EditorInfo.IME_ACTION_DONE);
                if (android.os.Build.VERSION.SDK_INT >= 26) input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
                input.setHint("粘贴你自己的 API Key");
                AlertDialog dialog = new AlertDialog.Builder(getActivity())
                    .setTitle(("deepseek".equals(selected) ? "DeepSeek" : "MiMo") + " API Key")
                    .setMessage("仅保存在本机，不随资料同步或备份。这里不会发起付费请求。")
                    .setView(input).setNegativeButton("取消", (d, which) -> finish(false, null))
                    .setPositiveButton("安全保存", null).create();
                dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                    if (activeCall != call) return;
                    try { vault.store(selected, input.getText().toString().trim()); finish(true, null); }
                    catch (IllegalArgumentException error) { input.setError("请检查Key格式，不包含空格。"); }
                    catch (Exception error) { finish(false, "本机凭据未保存，请重试。"); }
                }));
                show(dialog);
            } catch (RuntimeException error) { finish(false, "凭据窗口暂时无法打开，请重新进入设置。"); }
        });
    }
    @PluginMethod public void clear(PluginCall call) {
        String selected = provider(call); if (selected == null) return;
        onUi(call, () -> {
            if (!beginDialog(call)) return;
            try {
                AlertDialog dialog = new AlertDialog.Builder(getActivity()).setTitle("移除本机凭据？")
                    .setMessage("已保存的回答和学习记录不会删除。")
                    .setNegativeButton("取消", (d, which) -> finish(false, null))
                    .setPositiveButton("移除", (d, which) -> {
                        if (activeCall != call) return;
                        try { vault.clear(selected); finish(true, null); }
                        catch (Exception error) { finish(false, "凭据未能移除，请重试。"); }
                    }).create();
                show(dialog);
            } catch (RuntimeException error) { finish(false, "凭据窗口暂时无法打开，请重新进入设置。"); }
        });
    }
}
