type Schema=Record<string,unknown>;
const record=(value:unknown):value is Schema=>!!value&&typeof value==='object'&&!Array.isArray(value);
const permitsNull=(schema:Schema):boolean=>schema.type==='null'||Array.isArray(schema.type)&&schema.type.includes('null')||Array.isArray(schema.enum)&&schema.enum.includes(null)||Array.isArray(schema.anyOf)&&schema.anyOf.some(s=>record(s)&&permitsNull(s));

/** Strict Responses schemas require every property. Optional values use null on the wire only. */
export function strictResponseSchema(original:Schema):Schema{
  const convert=(node:Schema):Schema=>{
    const out={...node};delete out.$schema;delete out.default;
    if(record(node.properties)){
      const required=Array.isArray(node.required)?node.required:[];
      out.properties=Object.fromEntries(Object.entries(node.properties).map(([name,value])=>{
        const source=value as Schema,converted=convert(source);
        return [name,required.includes(name)||permitsNull(source)?converted:{anyOf:[converted,{type:'null'}]}];
      }));
      out.required=Object.keys(node.properties);out.additionalProperties=false;
    }
    for(const key of ['anyOf','oneOf','allOf'])if(Array.isArray(node[key]))out[key]=node[key].map(s=>record(s)?convert(s):s);
    if(record(node.items))out.items=convert(node.items);
    for(const key of ['$defs','definitions'])if(record(node[key]))out[key]=Object.fromEntries(Object.entries(node[key]).map(([name,s])=>[name,record(s)?convert(s):s]));
    return out;
  };
  return convert(original);
}

/** Restore omitted optional values before validating the unchanged application Zod contract. */
export function restoreOptionalValues(original:Schema,value:unknown):unknown{
  const resolve=(schema:Schema):Schema=>{
    if(typeof schema.$ref!=='string'||!schema.$ref.startsWith('#/'))return schema;
    let result:unknown=original;for(const part of schema.$ref.slice(2).split('/'))result=record(result)?result[part.replace(/~1/g,'/').replace(/~0/g,'~')]:undefined;
    return record(result)?result:schema;
  };
  const visit=(schema:Schema,data:unknown):unknown=>{
    schema=resolve(schema);
    if(Array.isArray(schema.anyOf)){const candidate=schema.anyOf.find(s=>record(s)&&(data===null?permitsNull(s):Array.isArray(data)?s.type==='array':record(data)?s.type==='object'||record(s.properties):s.type===typeof data));if(record(candidate))schema=resolve(candidate);}
    if(Array.isArray(data)&&record(schema.items))return data.map(item=>visit(schema.items as Schema,item));
    if(!record(data)||!record(schema.properties))return data;
    const required=Array.isArray(schema.required)?schema.required:[];
    return Object.fromEntries(Object.entries(data).filter(([key,item])=>{const property=schema.properties as Schema;return !(item===null&&!required.includes(key)&&record(property[key])&&!permitsNull(resolve(property[key] as Schema)));}).map(([key,item])=>{const property=(schema.properties as Schema)[key];return [key,record(property)?visit(property,item):item];}));
  };
  return visit(original,value);
}
