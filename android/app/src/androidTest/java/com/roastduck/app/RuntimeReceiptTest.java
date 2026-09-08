package com.roastduck.app;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import static org.junit.Assert.*;
import org.json.JSONObject;
import java.io.File;
import java.util.UUID;

public class RuntimeReceiptTest {
    @Test public void persistedResponseSurvivesARecreatedStoreAndRejectsDifferentPayload() throws Exception {
        var context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        String run="receipt-test-"+UUID.randomUUID();
        RuntimeReceiptStore store=new RuntimeReceiptStore(context);
        assertNull(store.begin(run,"input-hash"));
        store.finish(run,"completed",200,"{\"synthetic\":true}");
        RuntimeReceiptStore reopened=new RuntimeReceiptStore(context);
        assertEquals("completed",reopened.read(run).getString("state"));
        assertNotNull(reopened.begin(run,"input-hash"));
        try {reopened.begin(run,"different");fail("must reject mismatched request");} catch(IllegalArgumentException expected) {assertEquals("request_hash_conflict",expected.getMessage());}
    }
    @Test public void atomicBackupIsRecoveredRatherThanMistakenForAnUnsentRequest() throws Exception {
        var context=InstrumentationRegistry.getInstrumentation().getTargetContext();String run="backup-test-"+UUID.randomUUID();
        RuntimeReceiptStore store=new RuntimeReceiptStore(context);store.begin(run,"same");store.finish(run,"completed",200,"{}");
        File base=new File(context.getFilesDir(),"runtime-receipts/"+RuntimeReceiptStore.hash(run)+".json");
        assertTrue(base.renameTo(new File(base.getAbsolutePath()+".bak")));
        assertEquals("completed",new RuntimeReceiptStore(context).read(run).getString("state"));
    }
    @Test public void requestPolicyNeverPermitsAnArbitraryModelOrTool() throws Exception {
        JSONObject valid=new JSONObject().put("model","deepseek-v4-flash").put("input","synthetic").put("instructions","synthetic").put("max_output_tokens",100);
        RuntimeHttp.validate(valid.toString());
        valid.put("tools",new org.json.JSONArray());
        try {RuntimeHttp.validate(valid.toString());fail("tools forbidden");} catch(IllegalArgumentException expected) {}
        valid.remove("tools");valid.put("model","unexpected");
        try {RuntimeHttp.validate(valid.toString());fail("wrong model forbidden");} catch(IllegalArgumentException expected) {}
        assertEquals("https://api.deepseek.com/responses",RuntimeHttp.DEEPSEEK_URL);
    }
}
