import Link from 'next/link';

export default async function ExtensionsPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const params=await searchParams,material=typeof params.material==='string'?params.material:null;
  const scope=material?`&scope=material&id=${encodeURIComponent(material)}`:'';
  return <div className="page-content"><header className="page-header"><div><h1>拓展功能</h1><p>旧学习方式与历史记录保留在这里。日常学习和复习以句子为单位。</p></div></header><div className="extension-list">
    <Link href={`/light-study?extension=1&mode=learn${scope}`}><h2>语块轻学习</h2><p>按单个表达回想，使用原有的五项分组和进度。</p><span>打开语块学习</span></Link>
    <Link href={`/quick-review?extension=1${scope}`}><h2>表格与快速回顾</h2><p>查看中文、英文对照，自由遮挡答案；不更新复习进度。</p><span>打开对照回顾</span></Link>
    <Link href={material?`/training/${encodeURIComponent(material)}?extension=1`:'/review?extension=1'}><h2>四步强化</h2><p>需要严格的提取练习时使用；保留此前的暂停位置与成绩。</p><span>{material?'强化这份材料':'查看原复习与强化'}</span></Link>
    <Link href="/expressions?extension=1"><h2>表达收藏与管理</h2><p>查看原语块收藏、备注与停推设置，历史学习记录继续保留。</p><span>查看表达与旧记录</span></Link>
    <Link href="/speaking-arena?extension=1"><h2>旧口语输出训练</h2><p>保留原口语会话与分级提示。新学习路线使用连续老师反馈。</p><span>查看兼容输出入口</span></Link>
  </div><Link className="exit-button" href="/">返回首页</Link></div>;
}
