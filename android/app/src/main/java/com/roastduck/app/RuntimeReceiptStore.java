package com.roastduck.app;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Private transport receipts contain no API headers or keys. Completed response precedes JS delivery. */
final class RuntimeReceiptStore {
    private final File directory;
    RuntimeReceiptStore(Context context) throws IOException {
        directory = new File(context.getFilesDir(), "runtime-receipts");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create receipt directory");
    }
    static String hash(String text) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder output = new StringBuilder(); for (byte value : bytes) output.append(String.format("%02x", value & 255));
        return output.toString();
    }
    private AtomicFile file(String runId) throws Exception { return new AtomicFile(new File(directory, hash(runId) + ".json")); }
    synchronized JSONObject read(String runId) throws Exception {
        AtomicFile source = file(runId);
        // openRead also restores AtomicFile's backup after a crash between rename/write.
        try (FileInputStream input = source.openRead()) {
            if (input.getChannel().size() > 9 * 1024 * 1024) throw new IOException("Receipt too large");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int read;
            while ((read = input.read(buffer)) != -1) {
                if (bytes.size() + read > 9 * 1024 * 1024) throw new IOException("Receipt too large");
                bytes.write(buffer, 0, read);
            }
            return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        } catch (FileNotFoundException absent) { return null; }
    }
    synchronized void write(String runId, JSONObject value) throws Exception {
        AtomicFile target = file(runId); FileOutputStream stream = null;
        try { stream = target.startWrite(); stream.write(value.toString().getBytes(StandardCharsets.UTF_8)); target.finishWrite(stream); }
        catch (Exception error) { if (stream != null) target.failWrite(stream); throw error; }
    }
    synchronized JSONObject begin(String runId, String requestHash) throws Exception {
        JSONObject prior = read(runId);
        if (prior != null) {
            if (!requestHash.equals(prior.optString("requestHash"))) throw new IllegalArgumentException("request_hash_conflict");
            return prior;
        }
        JSONObject receipt = new JSONObject().put("runId", runId).put("requestHash", requestHash)
            .put("state", "pending").put("createdAt", System.currentTimeMillis());
        write(runId, receipt); return null;
    }
    synchronized void finish(String runId, String state, int status, String body) throws Exception {
        JSONObject receipt = read(runId);
        if (receipt == null) throw new IOException("Request receipt missing");
        receipt.put("state", state).put("httpStatus", status).put("completedAt", System.currentTimeMillis());
        if (body != null) receipt.put("body", body);
        write(runId, receipt);
    }
}
