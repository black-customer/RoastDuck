import {expect,it} from 'vitest';
import {localJson} from '@/lib/http/local-write';
const request=(headers:Record<string,string>,body='{}')=>new Request('http://localhost:3001/api/speech/synthesis',{method:'POST',headers,body});
it('rejects cross-site and simple requests before any paid service is called',async()=>{
  const cases:Record<string,string>[]=[{'Content-Type':'application/json',Origin:'https://evil.example'},{'Content-Type':'text/plain'}, {'Content-Type':'application/json','Sec-Fetch-Site':'cross-site'}];
  for(const headers of cases)await expect(localJson(request(headers))).rejects.toMatchObject({status:403});
  expect(await localJson(request({'Content-Type':'application/json',Origin:'http://localhost:3001'}))).toEqual({});
  expect(await localJson(request({'Content-Type':'application/json'}))).toEqual({});
  expect(await localJson(request({'Content-Type':'application/json',Host:'127.0.0.1:3001',Origin:'http://127.0.0.1:3001'}))).toEqual({});
  await expect(localJson(request({'Content-Type':'application/json',Host:'evil.example',Origin:'http://evil.example'}))).rejects.toMatchObject({status:403});
  await expect(localJson(request({'Content-Type':'application/json',Host:'localhost:3001',Origin:'http://localhost:3002'}))).rejects.toMatchObject({status:403});
});
it('bounds streamed bytes as well as content length and never echoes secret input',async()=>{
  await expect(localJson(request({'Content-Type':'application/json'},'"'+ 'x'.repeat(100)+'"'),30)).rejects.toMatchObject({status:413});
  await expect(localJson(request({'Content-Type':'application/json'},'private-text'))).rejects.toThrow('JSON 格式不正确');
});
