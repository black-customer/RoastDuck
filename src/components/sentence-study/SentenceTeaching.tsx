import type {SentenceCard} from '@/lib/sentence-study/contracts';
import styles from './SentenceTeaching.module.css';

export function SentenceTeaching({card}:{card:SentenceCard}){
  const teaching=card.teaching;
  return <section className={styles.teaching} aria-label="这句怎么说">
    <h2>这句怎么说</h2>
    {teaching?<>
      <p className={styles.overview}>{teaching.overviewZh}</p>
      <div className={styles.parts}>{teaching.parts.map((part,index)=><section key={index} className={styles.part}>
        {part.cueZh!==card.chinese&&<h3>{part.cueZh}</h3>}
        {part.quoteEn!==card.english&&<p className={styles.quote} lang="en">{part.quoteEn}</p>}
        <p className={styles.explanation}>{part.explanationZh}</p>
        {part.pattern&&<p className={styles.pattern}><span>可复用结构</span><span lang="en">{part.pattern}</span></p>}
        {(part.examples.length>0||part.alternatives.length>0||part.contrastZh)&&<details>
          <summary>例句、辨析与其他说法</summary>
          {part.contrastZh&&<p className={styles.contrast}>{part.contrastZh}</p>}
          {part.examples.length>0&&<div className={styles.examples}><p className={styles.subheading}>换个意思试试</p>{part.examples.map((example,i)=><div key={i}><p lang="en">{example.english}</p><p>{example.chinese}</p></div>)}</div>}
          {part.alternatives.length>0&&<div className={styles.alternatives}><p className={styles.subheading}>也可以这样说</p>{part.alternatives.map((alternative,i)=><div key={i}><p lang="en">{alternative.english}</p><p>{alternative.chinese}</p><p className={styles.when}>{alternative.whenZh}</p></div>)}</div>}
        </details>}
      </section>)}</div>
    </>:<p className={styles.missing}>这句的详细讲解还在补齐。可以先看参考表达，不影响继续学习。</p>}
    {card.notes.length>0&&<section className={styles.notes}><h3>本句注意点</h3>{card.notes.map(note=><div key={note.id} className={styles.note}><p>{note.kind==='suggestion'?'表达建议：':''}{note.textZh}</p>{note.evidence&&<details><summary>看看我之前怎么说</summary><p lang="en">{note.evidence}</p></details>}</div>)}</section>}
  </section>;
}
