package com.roastduck.app;
import javax.net.ssl.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.*;
import org.json.JSONObject;

/** Trust exactly the QR-pinned certificate, plus validity and the normal hostname check. Never trust-all. */
final class PinnedSyncHttp {
    static boolean privateAddress(String host,boolean debug){
        if(host==null||!host.matches("(0|[1-9][0-9]{0,2})(\\.(0|[1-9][0-9]{0,2})){3}"))return false;
        String[] parts=host.split("\\.");int[] n=new int[4];for(int i=0;i<4;i++){n[i]=Integer.parseInt(parts[i]);if(n[i]>255)return false;}
        return n[0]==10||(n[0]==192&&n[1]==168)||(n[0]==172&&n[1]>=16&&n[1]<=31)||(debug&&n[0]==127);
    }
    static void validateEndpoint(String endpoint,boolean debug) throws Exception {
        URI uri=new URI(endpoint);
        if(!"https".equals(uri.getScheme())||!privateAddress(uri.getHost(),debug)||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||!(uri.getPath()==null||uri.getPath().isEmpty())||uri.getPort()<1||uri.getPort()>65535)throw new IllegalArgumentException("Invalid private endpoint");
    }
    static X509TrustManager trust(String fingerprint){
        if(fingerprint==null||!fingerprint.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Invalid certificate fingerprint");
        return new X509TrustManager(){
            public X509Certificate[] getAcceptedIssuers(){return new X509Certificate[0];}
            public void checkClientTrusted(X509Certificate[] chain,String auth) throws CertificateException {throw new CertificateException("Client certificates are not accepted here");}
            public void checkServerTrusted(X509Certificate[] chain,String auth) throws CertificateException {
                if(chain==null||chain.length!=1)throw new CertificateException("Unexpected certificate chain");
                chain[0].checkValidity();
                try{chain[0].verify(chain[0].getPublicKey());String actual=AudioStore.digest(chain[0].getEncoded());if(!MessageDigest.isEqual(actual.getBytes(StandardCharsets.US_ASCII),fingerprint.getBytes(StandardCharsets.US_ASCII)))throw new CertificateException("Certificate pin mismatch");}
                catch(CertificateException error){throw error;}catch(Exception error){throw new CertificateException("Certificate validation failed",error);}
            }
        };
    }
    static JSONObject request(String endpoint,String fingerprint,String route,String method,String body,String localId,String token,boolean debug) throws Exception {
        validateEndpoint(endpoint,debug);
        if(!route.matches("/(pair/request|pair/result|manifest|prepare|receipt|changes(?:\\?after=[0-9]{1,15})?|media/manifest|media/chunk(?:\\?hash=[a-f0-9]{64}&offset=[0-9]{1,10})?)"))throw new IllegalArgumentException("Unsupported sync route");
        if(!"GET".equals(method)&&!"POST".equals(method))throw new IllegalArgumentException("Unsupported method");
        SSLContext tls=SSLContext.getInstance("TLS");tls.init(null,new TrustManager[]{trust(fingerprint)},new SecureRandom());
        HttpsURLConnection connection=(HttpsURLConnection)new URL(endpoint+route).openConnection();
        connection.setSSLSocketFactory(tls.getSocketFactory()); // Leave the default hostname verifier enabled.
        try{
            connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(10000);connection.setReadTimeout(30000);connection.setRequestMethod(method);
            if(token!=null){connection.setRequestProperty("Authorization","Bearer "+token);connection.setRequestProperty("X-Device-Id",localId);}
            if("POST".equals(method)){byte[] bytes=(body==null?"{}":body).getBytes(StandardCharsets.UTF_8);if(bytes.length>4500000)throw new IOException("Sync body too large");connection.setDoOutput(true);connection.setRequestProperty("Content-Type","application/json");connection.setFixedLengthStreamingMode(bytes.length);try(OutputStream out=connection.getOutputStream()){out.write(bytes);}}
            int status=connection.getResponseCode();if(status!=200)throw new IOException(status==401?"device_not_authorized":status==403?"pairing_expired_or_rejected":"sync_request_rejected");
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream in=connection.getInputStream()){byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1){if(bytes.size()+n>6500000)throw new IOException("Sync response too large");bytes.write(buffer,0,n);}}
            return new JSONObject(new String(bytes.toByteArray(),StandardCharsets.UTF_8));
        }finally{connection.disconnect();}
    }
}
