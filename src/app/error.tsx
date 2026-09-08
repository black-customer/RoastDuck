"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return <section className="page-error" role="alert"><h1>页面暂时没有加载出来</h1><p>请重新加载。你的本机学习记录没有被重置。</p><button type="button" className="primary-button" onClick={reset}>重新加载</button></section>;
}
