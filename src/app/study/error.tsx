'use client';
import Link from 'next/link';
export default function StudyError({reset}:{reset:()=>void}){
  return <section className="page-panel"><h1>暂时无法读取学习范围</h1><p>学习资料和进度仍然保留，可以重新读取，或先返回首页。</p><div className="row-actions"><button className="primary-button" onClick={reset}>重新读取</button><Link className="secondary-button" href="/">返回首页</Link></div></section>;
}
