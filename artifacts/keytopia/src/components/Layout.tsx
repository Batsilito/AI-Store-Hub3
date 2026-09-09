import { Link } from 'wouter';
import { ChevronLeft, ChevronRight, Home, Menu, Search, ShoppingBag, Store, User, X } from 'lucide-react';
import { useUser } from '@clerk/react';
import { useCart } from '../contexts/CartContext';
import { useLang } from '../contexts/LanguageContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useState } from 'react';
import CartDrawer from './CartDrawer';
import { useLocation } from 'wouter';

// Logo is served from the public/ folder
const logoImg = `${import.meta.env.BASE_URL}logo.png`;

function ChevronForDirection({ rtl }: { rtl: boolean }) {
  const Icon = rtl ? ChevronLeft : ChevronRight;
  return <Icon className="h-4 w-4" aria-hidden="true" />;
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const { cartCount } = useCart();
  const { t, toggleLang, dir } = useLang();
  const { currency, setCurrency } = useCurrency();
  const { isLoaded, isSignedIn } = useUser();
  const [location] = useLocation();
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const isProductPage = location.startsWith('/products/');
  const hideMobileNav = location.startsWith('/checkout') || location.startsWith('/admin') || isProductPage;
  const isCheckout = location.startsWith('/checkout');
  const navigation = dir === 'rtl'
    ? [
        { label: 'الرئيسية', href: '/' },
        { label: 'الأقسام', href: '/#products' },
        { label: 'من نحن', href: '/about' },
        { label: 'الاسترداد والخصوصية', href: '/policy' },
      ]
    : [
        { label: 'Home', href: '/' },
        { label: 'Categories', href: '/#products' },
        { label: 'About us', href: '/about' },
        { label: 'Refunds & privacy', href: '/policy' },
      ];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background" dir={dir}>
      {isCheckout ? (
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex h-16 max-w-[1120px] items-center justify-between gap-3 px-4 sm:px-6">
            <Link href="/" className="flex h-10 w-28 items-center overflow-hidden sm:w-36" aria-label="Keytopia">
              <img src={logoImg} alt="Keytopia" className="h-32 w-auto max-w-none object-contain sm:h-40" />
            </Link>
            <div className="flex items-center gap-1.5 sm:gap-2">
              <button onClick={toggleLang} aria-label="Toggle language" className="grid min-h-11 min-w-11 place-items-center rounded-lg border border-slate-200 px-2 text-xs font-bold hover:bg-slate-50">{t('toggleLang')}</button>
              <button onClick={() => setCurrency(currency === 'EGP' ? 'USD' : 'EGP')} aria-label={currency === 'EGP' ? t('switchToUsd') : t('switchToEgp')} className="grid min-h-11 min-w-11 place-items-center rounded-lg border border-slate-200 px-2 text-xs font-bold hover:bg-slate-50">{currency}</button>
              <Link href="/" className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 hover:text-primary">
                {dir === 'rtl' ? 'العودة للسلة' : 'Back to cart'}
                <ChevronForDirection rtl={dir === 'rtl'} />
              </Link>
            </div>
          </div>
        </header>
      ) : <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl border-b border-black/[0.03]">
        <div className="max-w-7xl mx-auto px-3 md:px-6 h-16 md:h-20 flex items-center justify-between gap-2 md:gap-5">
          <button onClick={() => setIsMenuOpen(true)} aria-label={dir === 'rtl' ? 'فتح القائمة' : 'Open menu'} className="lg:hidden grid h-11 w-11 place-items-center rounded-xl text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary">
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/" className="flex h-10 w-24 sm:w-32 md:h-14 md:w-44 items-center overflow-hidden select-none">
            <img
              src={logoImg}
              alt="Keytopia"
              className="h-28 sm:h-36 md:h-44 w-auto max-w-none shrink-0 object-contain"
            />
          </Link>

          <nav aria-label={dir === 'rtl' ? 'التنقل الرئيسي' : 'Main navigation'} className="hidden lg:flex items-center justify-center gap-6 xl:gap-9 text-sm font-semibold text-muted-foreground">
            {navigation.map((item) => (
              <a key={item.label} href={item.href} className="whitespace-nowrap hover:text-primary transition-colors">
                {item.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-1 md:gap-3">
            <a href="/#products" aria-label={dir === 'rtl' ? 'البحث' : 'Search'} className="lg:hidden grid h-11 w-11 place-items-center rounded-xl hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary"><Search className="h-5 w-5" /></a>
            {/* Language Toggle */}
            <button
              onClick={toggleLang}
              aria-label="Toggle language"
              className="hidden sm:block h-9 px-4 rounded-full border border-black/[0.08] bg-muted hover:bg-muted/80 text-sm font-semibold text-foreground transition-all"
            >
              {t('toggleLang')}
            </button>

            {/* Currency Toggle */}
            <button
              onClick={() => setCurrency(currency === 'EGP' ? 'USD' : 'EGP')}
              aria-label={currency === 'EGP' ? t('switchToUsd') : t('switchToEgp')}
              title={currency === 'EGP' ? t('switchToUsd') : t('switchToEgp')}
              className="hidden sm:block h-9 min-w-[3.75rem] px-3 rounded-full border border-black/[0.08] bg-muted hover:bg-muted/80 text-sm font-semibold text-foreground transition-all"
            >
              {currency}
            </button>

            {/* Cart */}
            <button
              onClick={() => setIsCartOpen(true)}
              aria-label={t('cartAriaLabel')}
              className="relative grid h-11 w-11 place-items-center rounded-xl hover:bg-black/[0.03] transition-colors focus-visible:ring-2 focus-visible:ring-primary"
            >
              <ShoppingBag className="w-6 h-6 text-foreground" strokeWidth={1.5} />
              {cartCount > 0 && (
                <span className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center bg-primary text-white text-xs font-bold rounded-full border-2 border-background">
                  {cartCount}
                </span>
              )}
            </button>

            {/* Sign in / My Profile */}
            {isLoaded && (
              isSignedIn ? (
                <Link
                  href="/orders"
                  aria-label={dir === 'rtl' ? 'حسابي' : 'My account'}
                  className="hidden lg:flex h-9 px-4 rounded-full bg-primary hover:bg-primary/90 text-white text-sm font-semibold items-center gap-1.5 transition-all"
                >
                  <User className="w-4 h-4" strokeWidth={2} />
                  {dir === 'rtl' ? 'ملفي الشخصي' : 'My Profile'}
                </Link>
              ) : (
                <Link
                  href="/sign-in"
                  aria-label={dir === 'rtl' ? 'تسجيل الدخول' : 'Sign in'}
                  className="hidden lg:flex h-9 px-4 rounded-full bg-primary hover:bg-primary/90 text-white text-sm font-semibold items-center gap-1.5 transition-all"
                >
                  <User className="w-4 h-4" strokeWidth={2} />
                  {dir === 'rtl' ? 'تسجيل الدخول' : 'Sign in'}
                </Link>
              )
            )}
          </div>
        </div>
      </header>}

      <main className="flex-1 flex flex-col">
        {children}
      </main>

      {!isCheckout && <footer className={`py-8 md:py-12 px-4 text-center text-sm text-muted-foreground border-t border-black/[0.03] mt-auto ${hideMobileNav ? '' : 'pb-24 md:pb-12'}`}>
        <p>&copy; {new Date().getFullYear()} Keytopia. {t('allRightsReserved')}</p>
        <div className="mt-4 flex justify-center gap-6">
          <Link href="/policy" className="hover:text-foreground transition-colors">{t('policyLink')}</Link>
          <Link href="/orders" className="hover:text-foreground transition-colors">{dir === 'rtl' ? 'طلباتي' : 'My orders'}</Link>
          <Link href="/admin" className="hover:text-foreground transition-colors">{t('adminLogin')}</Link>
        </div>
      </footer>}

      <CartDrawer isOpen={isCartOpen} onClose={() => setIsCartOpen(false)} />

      {isMenuOpen && <div className="fixed inset-0 z-50 lg:hidden" dir={dir}>
        <button aria-label={dir === 'rtl' ? 'إغلاق القائمة' : 'Close menu'} onClick={() => setIsMenuOpen(false)} className="absolute inset-0 bg-slate-950/35" />
        <aside className={`absolute inset-y-0 w-[min(86vw,340px)] bg-white p-5 shadow-2xl ${dir === 'rtl' ? 'right-0' : 'left-0'}`} style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}>
          <div className="flex h-11 items-center justify-between border-b pb-4"><strong className="text-lg text-secondary">Keytopia</strong><button onClick={() => setIsMenuOpen(false)} className="grid h-11 w-11 place-items-center rounded-xl hover:bg-muted" aria-label={dir === 'rtl' ? 'إغلاق' : 'Close'}><X className="h-5 w-5" /></button></div>
          <nav className="mt-5 grid gap-1">{navigation.map(item => <a key={item.label} href={item.href} onClick={() => setIsMenuOpen(false)} className="flex min-h-12 items-center rounded-xl px-3 font-semibold hover:bg-blue-50 hover:text-primary">{item.label}</a>)}<Link href="/orders" onClick={() => setIsMenuOpen(false)} className="flex min-h-12 items-center rounded-xl px-3 font-semibold hover:bg-blue-50 hover:text-primary">{dir === 'rtl' ? 'طلباتي والكاش باك' : 'Orders & cashback'}</Link></nav>
          <div className="mt-5 grid grid-cols-2 gap-2 border-t pt-5"><button onClick={toggleLang} className="min-h-11 rounded-xl border font-semibold">{t('toggleLang')}</button><button onClick={() => setCurrency(currency === 'EGP' ? 'USD' : 'EGP')} className="min-h-11 rounded-xl border font-semibold">{currency}</button></div>
        </aside>
      </div>}

      {!hideMobileNav && <nav aria-label={dir === 'rtl' ? 'التنقل السفلي' : 'Bottom navigation'} className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-slate-200 bg-white/95 px-2 pt-1 backdrop-blur lg:hidden" style={{ paddingBottom: 'max(.35rem, env(safe-area-inset-bottom))' }}>
        {[{ href: '/', label: dir === 'rtl' ? 'الرئيسية' : 'Home', icon: Home }, { href: '/#products', label: dir === 'rtl' ? 'المتجر' : 'Store', icon: Store }, { href: '/#products', label: dir === 'rtl' ? 'البحث' : 'Search', icon: Search }, { href: isSignedIn ? '/orders' : '/sign-in', label: dir === 'rtl' ? 'حسابي' : 'Account', icon: User }].map(item => <a key={`${item.href}-${item.label}`} href={item.href} className={`flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-semibold ${location === item.href ? 'text-primary' : 'text-slate-500'}`}><item.icon className="h-5 w-5" /><span>{item.label}</span></a>)}
      </nav>}

      {/* Floating WhatsApp button stays behind drawers and is not repeated on checkout. */}
      {!location.startsWith('/checkout') && <a
        href="https://wa.me/201229327902"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="WhatsApp"
        className="hidden md:flex fixed bottom-6 start-6 z-30 items-center gap-3 px-5 py-3 rounded-full bg-[#25D366] shadow-lg hover:bg-[#20c35e] hover:scale-105 active:scale-95 transition-all"
      >
        <svg viewBox="0 0 24 24" className="w-6 h-6 fill-white shrink-0" xmlns="http://www.w3.org/2000/svg">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
        </svg>
        <span className="text-white font-semibold text-sm leading-tight whitespace-nowrap">
          عندك سؤال؟ تواصل معانا
        </span>
      </a>}
    </div>
  );
}
