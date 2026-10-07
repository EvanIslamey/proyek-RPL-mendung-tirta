import React from 'react';
import Link from 'next/link';
import styles from './Header.module.css';
import { Button } from '../ui/Button';

export const Header: React.FC = () => {
  return (
    <header className={`${styles.header} glass`}>
      <div className={`container ${styles.headerInner}`}>
        <Link href="/" className={styles.logo}>
          Mendung <span>Tirta</span>
        </Link>
        <nav className={styles.nav}>
          <Link href="#peralatan" className={styles.navLink}>Perlengkapan</Link>
          <Link href="#hasil-laut" className={styles.navLink}>Hasil Tangkapan</Link>
        </nav>
        <div className={styles.actions}>
          <Button variant="ghost">Masuk</Button>
          <Button variant="primary">Daftar</Button>
        </div>
      </div>
    </header>
  );
};
