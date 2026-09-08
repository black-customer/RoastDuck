import {beforeEach,describe,expect,it,vi} from 'vitest';

const service=vi.hoisted(()=>({list:vi.fn(),summary:vi.fn(),update:vi.fn()}));
vi.mock('@/lib/app-services/web',()=>({webExpressions:service}));

import {GET} from '@/app/api/expressions/route';

const summary={total:4,eligibleTotal:3,studied:1,eligibleStudied:1,selfKnownUnstudied:1,eligibleSelfKnownUnstudied:1,new:1,due:1,hidden:1};

describe('expression GET scope and read-only summary',()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    service.list.mockResolvedValue([{itemId:'item-1'}]);
    service.summary.mockResolvedValue(summary);
  });

  it.each([
    ['',{type:'all'}],
    ['?scope=all',{type:'all'}],
    ['?scope=collection&id=ielts',{type:'collection',id:'ielts'}],
    ['?scope=collection&id=free_talk',{type:'collection',id:'free_talk'}],
    ['?scope=collection&id=ielts&questionId=q1&topicId=t1&seasonId=s1',{type:'collection',id:'ielts',questionId:'q1',topicId:'t1',seasonId:'s1'}],
    ['?scope=question&id=question-1',{type:'question',id:'question-1'}],
    ['?scope=material&id=material-1',{type:'material',id:'material-1'}],
  ])('returns items and summary for %s',async(query,scope)=>{
    const response=await GET(new Request(`http://localhost/api/expressions${query}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({items:[{itemId:'item-1'}],summary});
    expect(service.list).toHaveBeenCalledWith('',scope,false);
    expect(service.summary).toHaveBeenCalledWith(scope);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('keeps search and hidden filtering on items, with a complete scope summary',async()=>{
    await GET(new Request('http://localhost/api/expressions?scope=collection&id=ielts&q=work&includeHidden=1'));
    expect(service.list).toHaveBeenCalledWith('work',{type:'collection',id:'ielts'},true);
    expect(service.summary).toHaveBeenCalledWith({type:'collection',id:'ielts'});
  });

  it('skips reading item payload for the homepage summary',async()=>{
    const response=await GET(new Request('http://localhost/api/expressions?scope=all&summaryOnly=1'));
    expect(await response.json()).toEqual({items:[],summary});
    expect(service.list).not.toHaveBeenCalled();
    expect(service.summary).toHaveBeenCalledWith({type:'all'});
    expect(service.update).not.toHaveBeenCalled();
  });

  it.each(['?scope=collection&id=retired_book','?scope=material','?scope=unknown','?scope=collection&id=free_talk&topicId=t1'])('rejects invalid scope before accessing data: %s',async query=>{
    const response=await GET(new Request(`http://localhost/api/expressions${query}`));
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(service.list).not.toHaveBeenCalled();
    expect(service.summary).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it('does not return a successful partial payload when summary fails',async()=>{
    service.summary.mockRejectedValueOnce(new Error('read failed'));
    const response=await GET(new Request('http://localhost/api/expressions?scope=all'));
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).not.toHaveProperty('items');
    expect(service.update).not.toHaveBeenCalled();
  });
});
