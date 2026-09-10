import Link from 'next/link';

export function LegacyModeGate({href,title='旧学习方式'}:{href:string;title?:string}){
  return <section className="page-error"><h1>{title}已移至拓展功能</h1><p>现在从完整中文意思开始，逐句回想自然英文。原有学习记录仍保留，你也可以继续体验之前的方式。</p><div className="row-actions"><Link className="primary-button" href="/study?mode=learn">开始句子学习</Link><Link className="secondary-button" href={href}>继续使用{title}</Link><Link className="exit-button" href="/extensions">查看拓展功能</Link></div></section>;
}

export function extensionHref(path:string,params:Record<string,string|string[]|undefined>={}){
  const query=new URLSearchParams();
  for(const [key,value] of Object.entries(params))if(typeof value==='string')query.set(key,value);
  query.set('extension','1');
  return `${path}?${query}`;
}
