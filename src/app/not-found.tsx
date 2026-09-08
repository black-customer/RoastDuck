import Link from "next/link";

export default function NotFound() {
  return <section className="page-error"><h1>这个页面没有找到</h1><p>链接可能已变更，已有的回答和学习记录不会受到影响。</p><Link href="/" className="primary-button">回到今日学习</Link></section>;
}
