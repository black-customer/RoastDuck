import Link from 'next/link';
import {ExpressionLibrary} from '@/components/ExpressionLibrary';
import {expressionScope,expressionScopeTitle} from '@/lib/light-study/scope-links';
import styles from '@/components/expressions/ExpressionCollection.module.css';
export default async function ExpressionsPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const parsed=expressionScope(await searchParams);
  if(!parsed.success)return <div className="page-content"><p role="alert">表达范围不正确，请从我的表达重新进入。</p><Link href="/expressions">我的表达</Link></div>;
  const scope=parsed.data;
  return <div className={`page-content ${styles.page}`}><header className={styles.header}><h1>{expressionScopeTitle(scope)}</h1><p>来自你自己的回答和对话。同一个意思共享学习记录，随时可以查看、复习或调整。</p></header>
    <nav className={styles.tabs} aria-label="个人表达集合"><Link href="/expressions?scope=collection&id=ielts" aria-current={scope.type==='collection'&&scope.id==='ielts'?'page':undefined}>我的雅思表达</Link><Link href="/expressions?scope=collection&id=free_talk" aria-current={scope.type==='collection'&&scope.id==='free_talk'?'page':undefined}>我的对话表达</Link></nav>
    <ExpressionLibrary key={JSON.stringify(scope)} scope={scope} showSummary/>
  </div>;
}
