package com.roastduck.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CredentialsPlugin.class);
        registerPlugin(RuntimePlugin.class);
        registerPlugin(SpeechPlugin.class);
        registerPlugin(DeviceSpeechPlugin.class);
        registerPlugin(StoragePlugin.class);
        registerPlugin(DeviceSyncPlugin.class);
        registerPlugin(BackupPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
