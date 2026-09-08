package com.roastduck.app;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.json.*;
import static org.junit.Assert.*;
public class AudioStoreTest {
    @Test public void waveIsStoredByBytesAndReusedWithoutAKeyOrNetwork() throws Exception {
        AudioStore store=new AudioStore(InstrumentationRegistry.getInstrumentation().getTargetContext());
        byte[] wave=new byte[44];System.arraycopy("RIFF".getBytes(),0,wave,0,4);System.arraycopy("WAVE".getBytes(),0,wave,8,4);
        String descriptor="{\"text\":\"Synthetic\"}",key=RuntimeReceiptStore.hash(descriptor);
        JSONObject saved=store.save(key,descriptor,wave),loaded=new AudioStore(InstrumentationRegistry.getInstrumentation().getTargetContext()).lookup(key);
        assertEquals(saved.getString("fileHash"),loaded.getString("fileHash"));assertEquals(44,loaded.getLong("bytes"));assertTrue(loaded.getString("uri").startsWith("file:"));
        try{store.lookup("../credentials");fail("path escape must fail");}catch(IllegalArgumentException expected){}
    }
    @Test public void unknownSynthesisCannotBeSilentlyRepeated() throws Exception {
        AudioStore store=new AudioStore(InstrumentationRegistry.getInstrumentation().getTargetContext());String key=RuntimeReceiptStore.hash(java.util.UUID.randomUUID().toString());
        store.begin(key,false);try{store.begin(key,false);fail("explicit retry required");}catch(IllegalStateException expected){}
        store.begin(key,true);
    }
}
