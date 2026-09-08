package com.roastduck.app;

import org.json.JSONArray;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** Fixed HTTPS destination. Neither JS URLs nor redirect targets ever receive the credential. */
final class RuntimeHttp {
    interface ConnectionFactory { HttpsURLConnection open(URL url) throws IOException; }
    static final String DEEPSEEK_URL = "https://api.deepseek.com/responses";
    private final ConnectionFactory factory;
    RuntimeHttp() { this(url -> (HttpsURLConnection) url.openConnection()); }
    RuntimeHttp(ConnectionFactory factory) { this.factory = factory; }
    static void validate(String body) throws Exception {
        if (body.getBytes(StandardCharsets.UTF_8).length > 1024 * 1024) throw new IllegalArgumentException("Request too large");
        JSONObject value = new JSONObject(body);
        if (!"deepseek-v4-flash".equals(value.optString("model"))) throw new IllegalArgumentException("Unexpected model");
        Set<String> allowed = new HashSet<>(Arrays.asList("model","instructions","input","reasoning","max_output_tokens","text","user_id","temperature","stream"));
        for (Iterator<String> keys = value.keys(); keys.hasNext();) if (!allowed.contains(keys.next())) throw new IllegalArgumentException("Unsupported request field");
        if (!(value.opt("input") instanceof String) || !(value.opt("instructions") instanceof String) || value.optBoolean("stream", false)) throw new IllegalArgumentException("Text-only non-stream request required");
        int tokens = value.optInt("max_output_tokens", 0);
        if (tokens < 1 || tokens > 16384) throw new IllegalArgumentException("Output limit invalid");
    }
    static final class Result {
        final int status; final String body;
        Result(int status, String body) { this.status = status; this.body = body; }
    }
    Result post(String key, String body) throws Exception {
        validate(body);
        HttpsURLConnection connection = factory.open(new URL(DEEPSEEK_URL));
        ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
        timer.schedule(connection::disconnect, 120, TimeUnit.SECONDS);
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000); connection.setReadTimeout(90000);
            connection.setRequestMethod("POST"); connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + key);
            byte[] input = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(input.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(input); }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) return new Result(status, "{}"); // Never expose provider error bodies/headers.
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream stream = connection.getInputStream()) {
                byte[] buffer = new byte[8192]; int read;
                while ((read = stream.read(buffer)) != -1) {
                    if (bytes.size() + read > 8 * 1024 * 1024) throw new IOException("Response too large");
                    bytes.write(buffer, 0, read);
                }
            }
            JSONObject value = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
            // Reasoning is not learning material; never persist it in transport history.
            JSONArray output = value.optJSONArray("output"), messages = new JSONArray();
            if (output != null) for (int i = 0; i < output.length(); i++) {
                JSONObject item = output.optJSONObject(i);
                if (item != null && "message".equals(item.optString("type"))) messages.put(item);
            }
            value.put("output", messages);
            return new Result(status, value.toString());
        } finally { timer.shutdownNow(); connection.disconnect(); }
    }
}
