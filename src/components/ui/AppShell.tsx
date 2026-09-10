"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import { BrandMark, Icon, type IconName } from "./Icon";
import styles from "./AppShell.module.css";

const navigation: Array<{ href: string; label: string; icon: IconName; prefixes: string[] }> = [
  { href: "/", label: "今日学习", icon: "home", prefixes: ["/learn", "/light-study", "/study"] },
  { href: "/questions", label: "雅思题库", icon: "questions", prefixes: ["/questions", "/speaking-arena", "/answer-studio"] },
  { href: "/free-talk", label: "AI Free Talk", icon: "speaking", prefixes: ["/free-talk"] },
  { href: "/review", label: "到期复习", icon: "answers", prefixes: ["/review", "/training"] },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const expanded = expandedPath === pathname;
  const menu = useRef<HTMLButtonElement>(null);
  const close = () => setExpandedPath(null);
  return <div className={`${styles.shell} ${pathname==='/'||pathname==='/study'?styles.simple:''}`} data-app-shell>
    <a className={styles.skipLink} href="#main-content">跳到主要内容</a>
    <aside className={styles.sidebar} aria-label="工作台导航">
      <div className={styles.brandRow}>
        <Link href="/" className={styles.brand} aria-label="鱼块学英语首页" onClick={close}><BrandMark /><span>鱼块学英语</span></Link>
        <button ref={menu} type="button" className={styles.menuButton} aria-label="展开或收起导航" aria-expanded={expanded} aria-controls="workspace-navigation" onClick={() => setExpandedPath(expanded ? null : pathname)}><Icon name="menu" /></button>
      </div>
      <div id="workspace-navigation" className={styles.navigation} data-expanded={expanded} onKeyDown={(event) => {
        if (event.key === "Escape") { close(); menu.current?.focus(); }
      }}>
        <nav className={styles.primaryNav} aria-label="主导航">
          {navigation.map((item) => <Link key={item.href} href={item.href} className={styles.navLink}
            aria-current={pathname === item.href || item.prefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/")) ? "page" : undefined}
            onClick={close}><Icon name={item.icon} /><span>{item.label}</span></Link>)}
        </nav>
        <div className={styles.sidebarBottom}>
          <p className={styles.sidebarNote}>把想说的话，<br />变成会用的英语。</p>
          <nav aria-label="工具导航">
            <Link className={styles.navLink} aria-current={pathname === "/expressions" || pathname === "/quick-review" ? "page" : undefined} href="/expressions" onClick={close}><Icon name="answers" />我的表达</Link>
            <Link className={styles.navLink} aria-current={pathname === "/companion-memories" ? "page" : undefined} href="/companion-memories" onClick={close}><Icon name="memory" />Chloe 记得什么</Link>
            <Link className={styles.navLink} aria-current={pathname === "/search" ? "page" : undefined} href="/search" onClick={close}><Icon name="search" />搜索表达</Link>
            <Link className={styles.navLink} aria-current={["/settings", "/review-content"].includes(pathname) ? "page" : undefined} href="/settings" onClick={close}><Icon name="settings" />学习设置</Link>
          </nav>
        </div>
      </div>
    </aside>
    <main id="main-content" tabIndex={-1} className={styles.main}>{children}</main>
    <nav className={styles.mobileBottomNav} aria-label="移动端底部导航">
      <Link href="/" className={styles.mobileNavItem} aria-current={pathname === "/" || pathname.startsWith("/learn") ? "page" : undefined} onClick={close}>
        <Icon name="home" />
        <span>今天</span>
      </Link>
      <Link href="/questions" className={styles.mobileNavItem} aria-current={pathname.startsWith("/questions") ? "page" : undefined} onClick={close}>
        <Icon name="questions" />
        <span>题库</span>
      </Link>
      <Link href="/free-talk" className={styles.mobileNavItem} aria-current={pathname.startsWith("/free-talk") ? "page" : undefined} onClick={close}>
        <Icon name="speaking" />
        <span>对话</span>
      </Link>
      <Link href="/review" className={styles.mobileNavItem} aria-current={pathname.startsWith("/review") ? "page" : undefined} onClick={close}>
        <Icon name="answers" />
        <span>复习</span>
      </Link>
      <Link href="/settings" className={styles.mobileNavItem} aria-current={pathname.startsWith("/settings") ? "page" : undefined} onClick={close}>
        <Icon name="settings" />
        <span>我的</span>
      </Link>
    </nav>
  </div>;
}
