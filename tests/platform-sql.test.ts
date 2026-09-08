import { expect,it } from "vitest";
import { query,bindingSegments } from "../src/lib/platform/sql";
it("query fragments preserve bind order and never interpolate data as SQL",()=>{
  const value="'; DROP TABLE answers; --";
  const where=query`id=${value}`;
  expect(query`SELECT * FROM answers WHERE ${where} AND version=${3}`).toEqual({sql:"SELECT * FROM answers WHERE id=? AND version=?",args:[value,3]});
});
it("question marks in literals, quoted names and comments are not bind markers",()=>{
  const command={sql:"SELECT '?', 'it''s?', \"?\", [?], `?` -- ?\n FROM source WHERE id=? /* ? */ AND n=?",args:["id",2]};
  const segments=bindingSegments(command);
  expect(segments).toHaveLength(3);expect(segments[1]).toBe(" /* ? */ AND n=");
  expect(()=>bindingSegments({sql:"SELECT ?1",args:[1]})).toThrow("编号");
  expect(()=>bindingSegments({sql:"SELECT '?'",args:[1]})).toThrow("数量");
});
it("rejects SQLite Unicode named parameters but preserves quoted text and identifier dollars",()=>{
  for(const name of [":missing","@name","$name",":中文","@中文","$中文",":🙂"]){
    expect(()=>bindingSegments({sql:`SELECT ${name}`})).toThrow("命名");
  }
  expect(bindingSegments({sql:"SELECT 列$名, cost$usd, ':中文', \"@中文\" -- $中文\n"})).toHaveLength(1);
});
