import { motion, AnimatePresence } from 'framer-motion';
import {
  X, ChevronRight, ChevronLeft, Copy, Check, ExternalLink,
  User, Mail, Phone, CreditCard, Tag, CheckCircle2, AlertCircle,
  MessageCircle, Loader2, ShieldCheck, ShoppingBag, ArrowRight, Wallet, Banknote,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SignIn, useAuth } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { useCart, CartItem } from '../contexts/CartContext';
import Layout from '../components/Layout';
import { useLang } from '../contexts/LanguageContext';
import { getGetMyCashbackQueryKey, useCreateOrder, useGetMyCashback, useGetEgpUsdRate } from '@workspace/api-client-react';

type PaymentMethod = 'instapay' | 'vodafone' | 'paypal' | 'paylater' | 'card' | null;
type PayCurrency = 'EGP' | 'USD';

type PayPalOrder = { orderId: string };
type PayPalPaymentMethod = 'paypal' | 'paylater' | 'advanced_cards' | 'card';
type PayLaterDetails = { productCode: string; countryCode: string };
type PayPalEligibility = {
  isEligible: (method: PayPalPaymentMethod) => boolean;
  getDetails?: (method: PayPalPaymentMethod) => PayLaterDetails | undefined;
};
type PayPalSessionCallbacks = {
  onApprove: (data: { orderId: string }) => Promise<void>;
  onCancel?: (data?: { orderId?: string }) => void;
  onError?: (error: unknown) => void;
};
type PayPalPaymentSession = {
  start: (options: { presentationMode: 'auto'; targetElement?: HTMLElement }, order: Promise<PayPalOrder>) => Promise<void>;
};
type PayPalErrorPayload = {
  code?: string;
  message?: string;
  paypalDebugId?: string | null;
  requestId?: string;
};
class PayPalCheckoutError extends Error {
  constructor(
    readonly payload: PayPalErrorPayload,
    readonly httpStatus: number | null,
    fallbackMessage: string,
  ) {
    super(payload.message || fallbackMessage);
    this.name = 'PayPalCheckoutError';
  }
}

function errorPayload(value: unknown): PayPalErrorPayload {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  return {
    code: typeof raw.code === 'string' ? raw.code : undefined,
    message: typeof raw.message === 'string' ? raw.message : undefined,
    paypalDebugId: typeof raw.paypalDebugId === 'string' ? raw.paypalDebugId : null,
    requestId: typeof raw.requestId === 'string' ? raw.requestId : undefined,
  };
}

function checkoutErrorMessage(error: unknown, isRtl: boolean, fallback: string): string {
  const rawError = error as { data?: unknown; message?: unknown } | null;
  const data = rawError?.data;
  const serverMessage = data && typeof data === 'object' && typeof (data as Record<string, unknown>).error === 'string'
    ? (data as Record<string, string>).error
    : typeof rawError?.message === 'string' ? rawError.message : '';

  if (serverMessage.includes('selected products or durations')) {
    return isRtl
      ? 'أحد المنتجات أو المدد المختارة لم يعد متاحاً بهذه العملة. ارجع إلى السلة وحدّث الأسعار ثم حاول مرة أخرى.'
      : 'One of the selected products or durations is no longer available in this currency. Refresh your cart and try again.';
  }
  if (serverMessage.includes('Payment method is not valid')) {
    return isRtl ? 'طريقة الدفع هذه غير متوافقة مع العملة المختارة.' : 'This payment method is not compatible with the selected currency.';
  }
  if (serverMessage.includes('Cashback redemption')) {
    return isRtl ? 'تعذر استخدام الكاش باك بهذه القيمة. حدّث الرصيد وحاول مرة أخرى.' : 'This cashback amount could not be applied. Refresh your balance and try again.';
  }
  if (serverMessage && !serverMessage.startsWith('HTTP ')) return serverMessage;
  return fallback;
}

function reportPayPalError(error: unknown, context: string): void {
  if (!import.meta.env.DEV) return;
  if (error instanceof PayPalCheckoutError) {
    console.error(`[PayPal v6] ${context}`, {
      code: error.payload.code,
      message: error.payload.message,
      paypalDebugId: error.payload.paypalDebugId,
      requestId: error.payload.requestId,
      httpStatus: error.httpStatus,
    });
    return;
  }
  console.error(`[PayPal v6] ${context}`, error);
}
type PayPalCardFieldComponent = HTMLElement & { destroy?: () => void; focus?: () => void };
type PayPalCardFieldsSession = {
  createCardFieldsComponent: (options: {
    type: 'number' | 'expiry' | 'cvv';
    placeholder?: string;
  }) => PayPalCardFieldComponent;
  submit: (
    orderId: string,
    options?: { name?: string; billingAddress?: Record<string, string> },
  ) => Promise<{
    state: 'succeeded' | 'canceled' | 'failed';
    data?: { orderId?: string; message?: string };
  }>;
};
type PayPalSdk = {
  findEligibleMethods: (options: { currencyCode: string; amount: string }) => Promise<PayPalEligibility>;
  createPayPalOneTimePaymentSession: (options: PayPalSessionCallbacks) => PayPalPaymentSession;
  createPayLaterOneTimePaymentSession?: (options: PayPalSessionCallbacks) => PayPalPaymentSession;
  createPayPalGuestOneTimePaymentSession?: (options: PayPalSessionCallbacks) => PayPalPaymentSession;
  createCardFieldsOneTimePaymentSession: () => PayPalCardFieldsSession;
};

declare global {
  interface Window {
    paypal?: {
      createInstance: (options: {
        clientId: string;
        components: string[];
        pageType: 'checkout';
      }) => Promise<PayPalSdk>;
    };
  }
}

type PayPalMethod = 'paypal' | 'paylater' | 'card';

type PayPalCheckoutProps = {
  method: PayPalMethod;
  cardMode: Exclude<PayPalPaymentMethod, 'paypal'> | null;
  payLaterDetails: PayLaterDetails | null;
  sdk: PayPalSdk;
  createOrder: () => Promise<PayPalOrder>;
  cardholderName: string;
  onSuccess: (id: string) => Promise<void>;
  onError: (message: string) => void;
  isRtl: boolean;
  disabled: boolean;
  autoStart: boolean;
};

function PayPalCheckout({ method, cardMode, payLaterDetails, sdk, createOrder, cardholderName, onSuccess, onError, isRtl, disabled, autoStart }: PayPalCheckoutProps) {
  const buttonsContainer = useRef<HTMLDivElement>(null);
  const cardContainer = useRef<HTMLDivElement>(null);
  const cardSubmitButton = useRef<HTMLButtonElement>(null);
  const autoStartedRef = useRef(false);
  const [cardReady, setCardReady] = useState(false);

  useEffect(() => {
    let active = true;
    setCardReady(false);

    if ((method === 'paypal' || method === 'paylater') && buttonsContainer.current) {
      const button = document.createElement(method === 'paypal' ? 'paypal-button' : 'paylater-button') as HTMLElement & {
        productCode?: string;
        countryCode?: string;
      };
      if (method === 'paypal') button.setAttribute('type', 'pay');
      if (method === 'paylater') {
        if (!payLaterDetails) {
          onError(isRtl ? 'الدفع عبر Pay Later غير متاح لهذا الطلب.' : 'Pay Later is not available for this order.');
          return () => { active = false; };
        }
        button.productCode = payLaterDetails.productCode;
        button.countryCode = payLaterDetails.countryCode;
      }
      buttonsContainer.current.replaceChildren(button);
      const createSession = method === 'paypal'
        ? sdk.createPayPalOneTimePaymentSession
        : sdk.createPayLaterOneTimePaymentSession;
      if (!createSession) {
        onError(isRtl ? 'الدفع عبر Pay Later غير متاح حالياً.' : 'Pay Later is currently unavailable.');
        return () => { active = false; buttonsContainer.current?.replaceChildren(); };
      }
      const session = createSession({
        onApprove: ({ orderId }) => onSuccess(orderId),
        onCancel: () => onError(method === 'paylater'
          ? (isRtl ? 'تم إلغاء الدفع بالتقسيط. يمكنك المحاولة مرة أخرى.' : 'Pay Later payment was cancelled. You can try again.')
          : (isRtl ? 'تم إلغاء الدفع. يمكنك المحاولة مرة أخرى.' : 'Payment was cancelled. You can try again.')),
        onError: (error) => {
          reportPayPalError(error, method === 'paylater' ? 'Pay Later session error' : 'PayPal session error');
          onError(checkoutErrorMessage(error, isRtl, method === 'paylater'
            ? (isRtl ? 'تعذر بدء الدفع بالتقسيط. حاول مرة أخرى.' : 'Pay Later could not be started. Please try again.')
            : (isRtl ? 'PayPal غير متاح حالياً. حاول مرة أخرى لاحقاً.' : 'PayPal is currently unavailable. Please try again later.')));
        },
      });
      const startPayPal = () => {
        void session.start({ presentationMode: 'auto' }, createOrder()).catch((error) => {
          reportPayPalError(error, method === 'paylater' ? 'Pay Later session error' : 'PayPal session error');
          if (active) onError(checkoutErrorMessage(error, isRtl, method === 'paylater'
            ? (isRtl ? 'تعذر بدء الدفع بالتقسيط. حاول مرة أخرى.' : 'Pay Later could not be started. Please try again.')
            : (isRtl ? 'PayPal غير متاح حالياً. حاول مرة أخرى لاحقاً.' : 'PayPal is currently unavailable. Please try again later.')));
        });
      };
      const handleClick = () => {
        autoStartedRef.current = true;
        startPayPal();
      };
      button.addEventListener('click', handleClick);
      let autoStartTimer: ReturnType<typeof setTimeout> | undefined;
      if (autoStart && !autoStartedRef.current) {
        button.setAttribute('aria-label', 'Continue to PayPal');
        button.focus();
        autoStartTimer = setTimeout(() => {
          if (!active || autoStartedRef.current) return;
          autoStartedRef.current = true;
          startPayPal();
        }, 0);
      }
      return () => {
        active = false;
        if (autoStartTimer) clearTimeout(autoStartTimer);
        button.removeEventListener('click', handleClick);
        buttonsContainer.current?.replaceChildren();
      };
    }

    if (method !== 'card' || !cardMode || !cardContainer.current) {
      return () => { active = false; };
    }

    const container = cardContainer.current;
    container.replaceChildren();

    if (cardMode === 'card') {
      const basicCardContainer = document.createElement('paypal-basic-card-container');
      const basicCardButton = document.createElement('paypal-basic-card-button');
      basicCardContainer.appendChild(basicCardButton);
      container.appendChild(basicCardContainer);
      const guestSession = sdk.createPayPalGuestOneTimePaymentSession?.({
        onApprove: (data) => {
          const orderId = data?.orderId;
          if (!orderId) {
            onError(isRtl ? 'لم يُرجع PayPal رقم عملية الدفع. لم يتم تأكيد الطلب.' : 'PayPal did not return a payment order ID. The order was not confirmed.');
            return Promise.resolve();
          }
          return onSuccess(orderId);
        },
        onCancel: () => onError(isRtl ? 'تم إلغاء الدفع بالبطاقة. يمكنك المحاولة مرة أخرى.' : 'Card payment was cancelled. You can try again.'),
        onError: (error) => {
          reportPayPalError(error, 'Guest card session error');
          onError(checkoutErrorMessage(error, isRtl, isRtl ? 'تعذر إتمام الدفع بالبطاقة. حاول مرة أخرى.' : 'Card payment could not be completed. Please try again.'));
        },
      });

      if (!guestSession) {
        onError(isRtl ? 'الدفع بالبطاقة غير متاح حالياً.' : 'Card payment is currently unavailable.');
        return () => { active = false; container.replaceChildren(); };
      }

      const startGuestCard = () => {
        void guestSession.start({ presentationMode: 'auto', targetElement: basicCardButton }, createOrder()).catch((error) => {
          reportPayPalError(error, 'Guest card session error');
          if (active) onError(checkoutErrorMessage(error, isRtl, isRtl ? 'تعذر بدء الدفع بالبطاقة. حاول مرة أخرى.' : 'Card payment could not start. Please try again.'));
        });
      };
      const handleGuestClick = () => {
        autoStartedRef.current = true;
        startGuestCard();
      };
      basicCardButton.addEventListener('click', handleGuestClick);
      let autoStartTimer: ReturnType<typeof setTimeout> | undefined;
      if (autoStart && !autoStartedRef.current) {
        basicCardButton.setAttribute('aria-label', 'Enter card details');
        basicCardButton.focus();
        autoStartTimer = setTimeout(() => {
          if (!active || autoStartedRef.current) return;
          autoStartedRef.current = true;
          startGuestCard();
        }, 0);
      }
      setCardReady(true);
      return () => {
        active = false;
        if (autoStartTimer) clearTimeout(autoStartTimer);
        basicCardButton.removeEventListener('click', handleGuestClick);
        container.replaceChildren();
      };
    }

    const cardSession = sdk.createCardFieldsOneTimePaymentSession();
    const fields = (['number', 'expiry', 'cvv'] as const).map((type) => cardSession.createCardFieldsComponent({
      type,
      placeholder: type === 'number' ? 'Card number' : type === 'expiry' ? 'MM/YY' : 'CVV',
    }));
    fields.forEach((field) => {
      const fieldContainer = document.createElement('div');
      fieldContainer.className = 'mb-2 h-11 min-w-0 overflow-hidden rounded-lg border p-2 last:mb-0';
      fieldContainer.appendChild(field);
      container.appendChild(fieldContainer);
    });
    requestAnimationFrame(() => fields[0]?.focus?.());
    if (active) setCardReady(true);

    const submitCard = async () => {
      if (!active || disabled) return;
      try {
        const createdOrder = await createOrder();
        const result = await cardSession.submit(createdOrder.orderId, { name: cardholderName.trim() || undefined });
        if (result.state === 'succeeded') {
          await onSuccess(result.data?.orderId ?? createdOrder.orderId);
        } else if (result.state === 'canceled') {
          onError(isRtl ? 'تم إلغاء التحقق من البطاقة. حاول مرة أخرى.' : 'Card verification was cancelled. Please try again.');
        } else {
          onError(result.data?.message || (isRtl ? 'تم رفض البطاقة أو تعذر معالجتها. تحقق من البيانات وحاول مرة أخرى.' : 'The card was declined or could not be processed. Check the details and retry.'));
        }
      } catch (error) {
        reportPayPalError(error, 'Advanced card session error');
        onError(error instanceof PayPalCheckoutError
          ? (isRtl ? 'تعذر بدء الدفع بالبطاقة. حاول مرة أخرى.' : 'Card payment could not start. Please try again.')
          : checkoutErrorMessage(error, isRtl, isRtl ? 'تعذر إتمام الدفع بالبطاقة. حاول مرة أخرى.' : 'Card payment failed. Please try again.'));
      }
    };

    const payButton = cardSubmitButton.current;
    const handleSubmitClick = () => { void submitCard(); };
    payButton?.addEventListener('click', handleSubmitClick);
    return () => {
      active = false;
      payButton?.removeEventListener('click', handleSubmitClick);
      fields.forEach((field) => field.destroy?.());
      container.replaceChildren();
    };
  }, [method, cardMode, payLaterDetails, sdk, cardholderName, autoStart]);

  if (method === 'paypal' || method === 'paylater') return <div className={disabled ? 'pointer-events-none opacity-60' : ''} ref={buttonsContainer} />;
  return <div className="space-y-2 rounded-xl border border-black/10 bg-white p-3 sm:p-4">
    <div ref={cardContainer} className="min-h-11 min-w-0 overflow-hidden rounded-lg border p-2" />
    {cardMode === 'advanced_cards' && (
      <button ref={cardSubmitButton} type="button" disabled={disabled || !cardReady} className="w-full rounded-xl bg-[#0070ba] p-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{isRtl ? 'الدفع بالبطاقة' : 'Pay by card'}</button>
    )}
  </div>;
}

interface PromoState {
  status: 'idle' | 'loading' | 'valid' | 'invalid';
  code: string;
  percentage: number;
}

// wa.me requires an international number containing digits only.
const WA_NUMBER = '201229327902';
const WA_LINK = `https://wa.me/${WA_NUMBER}`;

const PAYMENT_INFO = {
  instapay: { link: 'https://ipn.eg/S/batsilitohsbc/instapay/7Gr2jR' },
  vodafone: { number: '01016712243' },
};

/** USD unit price for a cart item: prefer the admin-set USD price (by duration, then product-level), else approximate via the fallback rate. */
function getItemUsdUnitPrice(item: CartItem, fallbackEgpPerUsd: number): number {
  const option = item.pricingOptions?.find((opt) => opt.duration === item.selectedDuration);
  const usd = option ? (option.salePriceUsd ?? option.priceUsd) : (item.salePriceUsd ?? item.priceUsd);
  if (usd != null) return usd;
  return item.selectedCurrency === 'USD' ? item.selectedPrice : item.selectedPrice / fallbackEgpPerUsd;
}

function getItemEgpUnitPrice(item: CartItem, fallbackEgpPerUsd: number): number {
  const option = item.pricingOptions?.find((opt) => opt.duration === item.selectedDuration);
  if (option?.salePrice != null || option?.price != null) return option.salePrice ?? option.price;
  return item.selectedCurrency === 'EGP' ? item.selectedPrice : item.selectedPrice * fallbackEgpPerUsd;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="p-1.5 rounded-lg hover:bg-black/10 transition-colors text-muted-foreground hover:text-foreground"
      title="Copy"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-[#1CC88A]" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function VisaLogo() {
  return <span className="inline-flex h-7 min-w-12 items-center justify-center rounded bg-[#1434cb] px-2 text-[11px] font-black italic tracking-tight text-white">VISA</span>;
}

function MastercardLogo() {
  return <span className="inline-flex h-7 min-w-12 items-center justify-center rounded bg-white px-1.5" aria-label="Mastercard">
    <span className="-me-1.5 h-5 w-5 rounded-full bg-[#eb001b]" />
    <span className="h-5 w-5 rounded-full bg-[#f79e1b]/95" />
  </span>;
}

function PaypalLogo() {
  return <span className="inline-flex items-center gap-1.5 text-[#003087]" role="img" aria-label="PayPal">
    <span className="relative inline-block h-7 w-7 shrink-0" aria-hidden="true">
      <span className="absolute -top-1 start-1 text-[27px] font-black italic leading-none text-[#003087]">P</span>
      <span className="absolute top-0 start-0 text-[27px] font-black italic leading-none text-[#0070ba]">P</span>
    </span>
    <span className="text-base font-bold tracking-tight">PayPal</span>
  </span>;
}

function InstapayLogo() {
  return <span className="inline-flex items-center gap-1.5 text-[#1683d8]">
    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#1683d8] text-lg font-black text-white">i</span>
    <span className="text-base font-bold tracking-tight">instapay</span>
  </span>;
}

function VodafoneCashLogo() {
  return <span className="inline-flex items-center gap-1.5 text-[#e60000]">
    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#e60000] text-sm font-black text-white">V</span>
    <span className="text-sm font-bold leading-tight">Vodafone<br />Cash</span>
  </span>;
}

export default function Checkout() {
  const { items, clearCart, markCartRecovered } = useCart();
  const { dir } = useLang();
  const { isLoaded, isSignedIn } = useAuth();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const createOrderMutation = useCreateOrder();
  const { data: cashbackAccount } = useGetMyCashback({ query: { enabled: !!isSignedIn, queryKey: getGetMyCashbackQueryKey() } });
  const { data: exchange } = useGetEgpUsdRate();
  const rate = exchange?.rate ?? 52;

  const [name, setName] = useState(() => sessionStorage.getItem('checkout_name') ?? '');
  const [email, setEmail] = useState(() => sessionStorage.getItem('checkout_email') ?? '');
  const [phone, setPhone] = useState(() => sessionStorage.getItem('checkout_phone') ?? '');
  const [method, setMethod] = useState<PaymentMethod>(() => (sessionStorage.getItem('checkout_method') as PaymentMethod) ?? null);
  const [autoLaunchPayment, setAutoLaunchPayment] = useState(false);
  const [paymentLaunchNonce, setPaymentLaunchNonce] = useState(0);
  const [promoInput, setPromoInput] = useState('');
  const [promo, setPromo] = useState<PromoState>({ status: 'idle', code: '', percentage: 0 });
  const [cashbackInput, setCashbackInput] = useState('');
  const [cashbackUsed, setCashbackUsed] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sdkState, setSdkState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [sdk, setSdk] = useState<PayPalSdk | null>(null);
  const [paypalEligible, setPaypalEligible] = useState(false);
  const [payLaterEligible, setPayLaterEligible] = useState(false);
  const [payLaterDetails, setPayLaterDetails] = useState<PayLaterDetails | null>(null);
  const [cardMode, setCardMode] = useState<Exclude<PayPalPaymentMethod, 'paypal'> | null>(null);
  const [confirmation, setConfirmation] = useState<any>(null);
  const localOrderRef = useRef<any>(null);
  const idempotencyKeyRef = useRef(sessionStorage.getItem('checkout_idempotency') || crypto.randomUUID());
  const paymentDetailsRef = useRef<HTMLDivElement>(null);

  const currency: PayCurrency = method === 'paypal' || method === 'paylater' || method === 'card' ? 'USD' : 'EGP';
  const subtotal = items.reduce((sum, item) => sum + (currency === 'USD' ? getItemUsdUnitPrice(item, rate) : getItemEgpUnitPrice(item, rate)) * item.quantity, 0);
  const discount = promo.status === 'valid' ? Math.round(subtotal * promo.percentage) / 100 : 0;
  const beforeCashback = Math.max(0, subtotal - discount);
  const availableCashback = cashbackAccount?.balances.find(b => b.currency === currency)?.available ?? 0;
  const total = Math.max(0, beforeCashback - cashbackUsed);
  const productCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const customerFieldsReady = Boolean(
    name.trim()
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && /^[+\d][\d\s()-]{7,}$/.test(phone),
  );

  useEffect(() => {
    sessionStorage.setItem('checkout_idempotency', idempotencyKeyRef.current);
    sessionStorage.setItem('checkout_name', name);
    sessionStorage.setItem('checkout_email', email);
    sessionStorage.setItem('checkout_phone', phone);
    if (method) sessionStorage.setItem('checkout_method', method);
  }, [name, email, phone, method]);

  useEffect(() => {
    if (method !== 'paypal' && method !== 'paylater' && method !== 'card') return;
    paymentDetailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [method]);

  const validCustomer = () => {
    if (!name.trim()) return setError('يرجى إدخال الاسم الكامل.'), false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError('يرجى إدخال بريد إلكتروني صحيح.'), false;
    if (!/^[+\d][\d\s()-]{7,}$/.test(phone)) return setError('يرجى إدخال رقم هاتف صحيح.'), false;
    return true;
  };

  const applyPromo = async () => {
    const code = promoInput.trim().toUpperCase();
    if (!code) return;
    setPromo({ status: 'loading', code: '', percentage: 0 });
    try {
      const response = await fetch('/api/promo-codes/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, productIds: items.map(i => i.id) }) });
      const result = await response.json();
      setPromo(result.valid ? { status: 'valid', code: result.code, percentage: result.percentage } : { status: 'invalid', code: '', percentage: 0 });
    } catch { setPromo({ status: 'invalid', code: '', percentage: 0 }); }
  };

  const orderInput = (selected: Exclude<PaymentMethod, null>) => ({
    customerName: name.trim(), customerEmail: email.trim(), customerPhone: phone.trim(),
    currency: selected === 'paypal' || selected === 'paylater' || selected === 'card' ? 'USD' as const : 'EGP' as const,
    idempotencyKey: idempotencyKeyRef.current, promoCode: promo.status === 'valid' ? promo.code : null,
    cashbackAmount: cashbackUsed || undefined, referralCode: localStorage.getItem('keytopia_referral') ?? undefined,
    paymentMethod: selected,
    items: items.map(item => ({ productId: item.id, duration: item.selectedDuration, quantity: item.quantity })),
  });

  const createLocalOrder = async (selected: Exclude<PaymentMethod, null>) => {
    if (localOrderRef.current) return localOrderRef.current;
    const order = await createOrderMutation.mutateAsync({ data: orderInput(selected) });
    localOrderRef.current = order;
    return order;
  };

  const createPayPalOrder = async (): Promise<PayPalOrder> => {
    if (!method || (method !== 'paypal' && method !== 'paylater' && method !== 'card')) throw new Error('اختر وسيلة دفع تلقائية.');
    setBusy(true); setError('');
    try {
      const order = await createLocalOrder(method);
      const response = await fetch('/api/paypal/orders', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ localOrderId: order.id }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new PayPalCheckoutError(errorPayload(result), response.status, 'تعذر إنشاء عملية الدفع.');
      return { orderId: result.paypalOrderId };
    } finally { setBusy(false); }
  };

  const whatsappUrl = (order: any, automatic: boolean) => {
    const methodName = method === 'paypal' ? 'PayPal' : method === 'paylater' ? 'PayPal Pay Later' : method === 'card' ? 'بطاقة ائتمان أو خصم' : method === 'instapay' ? 'InstaPay' : 'Vodafone Cash';
    const lines = order.items.map((item: any) => `• ${item.productName} (${item.duration}) ×${item.quantity}`).join('\n');
    const note = automatic
      ? `تم الدفع تلقائياً باستخدام ${methodName} ولا يلزم إرسال إثبات دفع.`
      : 'يرجى إرفاق صورة إيصال التحويل يدوياً في هذه المحادثة.';
    return `${WA_LINK}?text=${encodeURIComponent(`مرحباً كيتوبيا،\n${note}\n\nرقم الطلب: ${order.orderNumber}\nالمنتجات:\n${lines}\nالمبلغ: ${order.total} ${order.currency}\nالاسم: ${order.customerName}\nالبريد: ${order.customerEmail}\nالهاتف: ${order.customerPhone}\nطريقة الدفع: ${methodName}`)}`;
  };

  const finish = async (order: any, automatic: boolean) => {
    await markCartRecovered(order.id);
    clearCart();
    queryClient.invalidateQueries({ queryKey: getGetMyCashbackQueryKey() });
    sessionStorage.removeItem('checkout_idempotency');
    setConfirmation({ order, automatic, whatsapp: whatsappUrl(order, automatic) });
  };

  const capture = async (paypalOrderId: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/paypal/orders/${encodeURIComponent(paypalOrderId)}/capture`, { method: 'POST', credentials: 'include' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.completed) throw new PayPalCheckoutError(errorPayload(result), response.status, 'لم يتم تأكيد الدفع.');
      await finish(localOrderRef.current, true);
    } catch (e) {
      reportPayPalError(e, 'capture');
      setError(
        e instanceof PayPalCheckoutError && e.payload.code === 'paypal_payment_verification_failed'
          ? 'تعذر التحقق من تفاصيل الدفع. لم يتم خصم الطلب.'
          : e instanceof PayPalCheckoutError && e.payload.code === 'paypal_compliance_violation'
            ? `رفض PayPal إتمام العملية بسبب قيود امتثال أو إعدادات الحساب. استخدم حساب مشتري Sandbox صالحاً وتحقق من حساب التاجر ثم حاول مرة أخرى.${e.payload.paypalDebugId ? ` رمز التتبع: ${e.payload.paypalDebugId}` : ''}`
            : 'لم تكتمل عملية الدفع. تحقق من وسيلة الدفع وحاول مرة أخرى.',
      );
    } finally { setBusy(false); }
  };

  const submitManual = async () => {
    if (busy || !method || !['instapay', 'vodafone'].includes(method) || !validCustomer()) return;
    setBusy(true); setError('');
    try { await finish(await createLocalOrder(method), false); }
    catch (error) {
      if (import.meta.env.DEV) console.error('[Checkout] local order creation failed', error);
      setError(checkoutErrorMessage(error, true, 'تعذر إنشاء الطلب. تحقق من بياناتك واتصال الإنترنت ثم حاول مرة أخرى.'));
    }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (method !== 'paypal' && method !== 'paylater' && method !== 'card') {
      setSdkState('idle'); setSdk(null); setPaypalEligible(false); setPayLaterEligible(false); setPayLaterDetails(null); setCardMode(null);
      return;
    }
    let active = true;
    setSdkState('loading'); setError('');
    (async () => {
      const configResponse = await fetch('/api/paypal/config');
      const config = await configResponse.json();
      if (!configResponse.ok || !config.available || !config.clientId) throw new Error('unavailable');
      if (!window.paypal?.createInstance) {
        const src = config.environment === 'live' ? 'https://www.paypal.com/web-sdk/v6/core' : 'https://www.sandbox.paypal.com/web-sdk/v6/core';
        let script = document.querySelector<HTMLScriptElement>('script[data-keytopia-paypal-sdk-v6]');
        if (!script) { script = document.createElement('script'); script.src = src; script.async = true; script.dataset.keytopiaPaypalSdkV6 = 'true'; document.head.appendChild(script); }
        await new Promise<void>((resolve, reject) => { if (window.paypal?.createInstance) return resolve(); script!.addEventListener('load', () => resolve(), { once: true }); script!.addEventListener('error', reject, { once: true }); });
      }
      if (!active || !window.paypal) return;
      const instance = await window.paypal.createInstance({ clientId: config.clientId, components: ['paypal-payments', 'card-fields', 'paypal-guest-payments'], pageType: 'checkout' });
      const eligible = await instance.findEligibleMethods({ currencyCode: 'USD', amount: total.toFixed(2) });
      if (!active) return;
       const eligibleForPayLater = eligible.isEligible('paylater');
       setSdk(instance); setPaypalEligible(eligible.isEligible('paypal')); setPayLaterEligible(eligibleForPayLater);
       setPayLaterDetails(eligibleForPayLater ? eligible.getDetails?.('paylater') ?? null : null);
      setCardMode(eligible.isEligible('advanced_cards') ? 'advanced_cards' : eligible.isEligible('card') ? 'card' : null);
       if (method === 'paylater' && !eligibleForPayLater) {
         sessionStorage.removeItem('checkout_method');
         setMethod(null);
         return;
       }
      setSdkState('ready');
    })().catch(() => { if (active) setSdkState('unavailable'); });
    return () => { active = false; };
  }, [method, total]);

  const selectMethod = (next: Exclude<PaymentMethod, null>) => {
    if (busy) return;
    if (method !== next) { localOrderRef.current = null; idempotencyKeyRef.current = crypto.randomUUID(); sessionStorage.setItem('checkout_idempotency', idempotencyKeyRef.current); }
     if (next === 'paypal' || next === 'paylater' || next === 'card') setPaymentLaunchNonce(current => current + 1);
     setAutoLaunchPayment(next === 'paypal' || next === 'paylater' || next === 'card');
    setMethod(next); setCashbackUsed(0); setCashbackInput(''); setError('');
  };

  if (confirmation) {
    const { order, automatic, whatsapp } = confirmation;
    return <Layout><main className="min-h-[75vh] bg-slate-50 px-4 py-10" dir="rtl"><section className="mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-xl shadow-slate-200/50 sm:p-10">
      <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-100"><CheckCircle2 className="h-9 w-9 text-emerald-600" /></div>
      <p className="mt-5 text-sm font-bold text-primary">رقم الطلب #{order.orderNumber}</p><h1 className="mt-2 text-2xl font-bold text-slate-950">{automatic ? 'تم الدفع بنجاح' : 'تم إنشاء طلبك'}</h1>
      <div className="mt-6 rounded-2xl bg-slate-50 p-4 text-right"><div className="flex justify-between"><span>حالة الدفع</span><strong className={automatic ? 'text-emerald-700' : 'text-amber-700'}>{automatic ? 'مدفوع' : 'في انتظار الدفع'}</strong></div><div className="mt-3 flex justify-between"><span>المبلغ</span><strong dir="ltr">{order.total} {order.currency}</strong></div></div>
      {!automatic && method === 'instapay' && <div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50 p-5 text-right"><h2 className="font-bold">الدفع عبر InstaPay</h2><p className="mt-2 text-sm">حوّل المبلغ الموضح بالكامل، ثم أرسل صورة التحويل عبر واتساب.</p><div className="mt-4 flex gap-2"><a className="flex min-h-12 flex-1 items-center justify-center rounded-xl bg-primary px-3 font-bold text-white" href={PAYMENT_INFO.instapay.link} target="_blank" rel="noreferrer">فتح InstaPay</a><CopyButton text={String(order.total)} /></div></div>}
      {!automatic && method === 'vodafone' && <div className="mt-5 rounded-2xl border border-red-100 bg-red-50 p-5 text-right"><h2 className="font-bold">التحويل إلى Vodafone Cash</h2><p className="mt-2 text-sm">حوّل المبلغ بالكامل إلى الرقم التالي، ثم احتفظ بصورة التحويل.</p><div className="mt-4 flex items-center justify-between rounded-xl bg-white p-3"><strong dir="ltr">{PAYMENT_INFO.vodafone.number}</strong><div className="flex"><CopyButton text={PAYMENT_INFO.vodafone.number} /><CopyButton text={String(order.total)} /></div></div></div>}
      <a href={whatsapp} target="_blank" rel="noreferrer" className="mt-6 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#20b858] px-5 font-bold text-white"><MessageCircle className="h-5 w-5" />{automatic ? 'إرسال تفاصيل الطلب عبر واتساب' : 'إرسال إثبات الدفع عبر واتساب'}</a>
      <button onClick={() => navigate('/orders')} className="mt-3 min-h-12 w-full text-sm font-bold text-slate-600">عرض طلباتي</button>
    </section></main></Layout>;
  }

  if (!items.length) return <Layout><div className="grid min-h-[65vh] place-items-center bg-slate-50 px-4" dir="rtl"><div className="max-w-md text-center"><ShoppingBag className="mx-auto h-12 w-12 text-slate-300"/><h1 className="mt-4 text-2xl font-bold">سلة التسوق فارغة</h1><p className="mt-2 text-slate-500">أضف منتجاً إلى سلتك قبل متابعة الدفع.</p><button onClick={() => navigate('/')} className="mt-6 min-h-12 rounded-xl bg-primary px-8 font-bold text-white">العودة إلى المتجر</button></div></div></Layout>;
  if (!isLoaded || !isSignedIn) return <Layout><div className="grid min-h-[65vh] place-items-center bg-slate-50 px-4">{!isLoaded ? <Loader2 className="h-8 w-8 animate-spin text-primary"/> : <SignIn routing="path" path={`${import.meta.env.BASE_URL?.replace(/\/$/, '') || ''}/sign-in`} forceRedirectUrl={`${import.meta.env.BASE_URL?.replace(/\/$/, '') || ''}/checkout`} />}</div></Layout>;

  const methods = [
    { id: 'instapay' as const, title: 'InstaPay', description: 'تحويل فوري آمن عبر تطبيق InstaPay', icon: <InstapayLogo />, currency: 'EGP' },
    { id: 'vodafone' as const, title: 'Vodafone Cash', description: 'تحويل إلى محفظة فودافون كاش', icon: <VodafoneCashLogo />, currency: 'EGP' },
    { id: 'paypal' as const, title: 'PayPal', description: 'الدفع من رصيدك أو حسابك على PayPal', icon: <PaypalLogo />, currency: 'USD' },
    { id: 'paylater' as const, title: 'PayPal Pay Later', description: 'الدفع على دفعات عبر PayPal عند توفر الأهلية', icon: <PaypalLogo />, currency: 'USD' },
    { id: 'card' as const, title: 'بطاقة ائتمان أو خصم', description: 'Visa أو Mastercard عبر بوابة PayPal الآمنة', icon: <div className="flex gap-1"><VisaLogo/><MastercardLogo/></div>, currency: 'USD' },
  ];
  const cta = method === 'paypal' ? 'الدفع باستخدام PayPal' : method === 'paylater' ? 'الدفع بالتقسيط عبر PayPal' : method === 'card' ? 'الدفع بالبطاقة' : method === 'instapay' ? 'المتابعة إلى InstaPay' : method === 'vodafone' ? 'عرض بيانات Vodafone Cash' : 'اختر وسيلة الدفع';
  const automaticPaymentPanel = (method === 'paypal' || method === 'paylater' || method === 'card') ? (
    <div ref={paymentDetailsRef} className="mt-5 scroll-mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-slate-600">
        <ShieldCheck className="h-4 w-4 text-emerald-600" />
        بيانات الدفع مشفرة وتُعالج بأمان عبر PayPal
      </div>
      {method === 'paypal' && <p className="mb-3 text-sm text-slate-600">سيتم فتح نافذة PayPal لتسجيل الدخول وإتمام الدفع بأمان.</p>}
      {method === 'paylater' && <p className="mb-3 text-sm text-slate-600">سيعرض PayPal خيارات الدفع على دفعات إذا كنت مؤهلاً لها.</p>}
      {method === 'card' && <p className="mb-3 text-sm text-slate-600">{cardMode === 'advanced_cards' ? 'أدخل بيانات بطاقة Visa أو Mastercard مباشرة في الحقول الآمنة أدناه.' : 'سيتم فتح نافذة PayPal الآمنة لإدخال بيانات بطاقة Visa أو Mastercard.'}</p>}
      {sdkState === 'loading' && <div className="flex min-h-14 items-center justify-center gap-2"><Loader2 className="h-5 w-5 animate-spin" />جار تجهيز الدفع الآمن…</div>}
      {sdkState === 'unavailable' && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">وسيلة الدفع غير متاحة حالياً. جرّب وسيلة أخرى أو حاول لاحقاً.</p>}
      {!customerFieldsReady && <button type="button" onClick={validCustomer} className="min-h-12 w-full rounded-xl bg-slate-900 px-4 font-bold text-white">{cta}</button>}
       {sdkState === 'ready' && ((method === 'paypal' && paypalEligible) || (method === 'paylater' && payLaterEligible && payLaterDetails) || (method === 'card' && cardMode)) && sdk && customerFieldsReady && (
        <PayPalCheckout
          key={`${method}-${paymentLaunchNonce}`}
          method={method}
          cardMode={cardMode}
           payLaterDetails={payLaterDetails}
          sdk={sdk}
          createOrder={createPayPalOrder}
          cardholderName={name}
          onSuccess={capture}
          onError={setError}
          isRtl
          disabled={busy}
          autoStart={autoLaunchPayment}
        />
      )}
    </div>
  ) : null;

  return <Layout><main className="bg-[#f6f8fb]" dir="rtl">
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-10">
      <button onClick={() => navigate('/')} className="mb-5 flex min-h-11 items-center gap-2 text-sm font-bold text-slate-600 hover:text-primary"><ArrowRight className="h-4 w-4"/>العودة إلى السلة والمتجر</button>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.08fr)_minmax(360px,.92fr)]">
        <section className="order-2 space-y-5 lg:order-1">
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-primary"><User className="h-5 w-5"/></div><div><h1 className="text-xl font-bold text-slate-950">بيانات العميل</h1><p className="text-sm text-slate-500">سنستخدمها لتأكيد وتسليم طلبك فقط</p></div></div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2"><label className="sm:col-span-2 text-sm font-bold">الاسم الكامل<input value={name} onChange={e=>setName(e.target.value)} autoComplete="name" className="mt-2 min-h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 outline-none focus:border-primary focus:ring-2 focus:ring-blue-100" placeholder="اكتب اسمك الكامل"/></label><label className="text-sm font-bold">البريد الإلكتروني<input type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" className="mt-2 min-h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 outline-none focus:border-primary focus:ring-2 focus:ring-blue-100" placeholder="name@example.com" dir="ltr"/></label><label className="text-sm font-bold">رقم الهاتف<input type="tel" value={phone} onChange={e=>setPhone(e.target.value)} autoComplete="tel" className="mt-2 min-h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 outline-none focus:border-primary focus:ring-2 focus:ring-blue-100" placeholder="01xxxxxxxxx" dir="ltr"/></label></div>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-primary"><Wallet className="h-5 w-5"/></div><div><h2 className="text-xl font-bold">وسيلة الدفع</h2><p className="text-sm text-slate-500">اختر الطريقة المناسبة لك</p></div></div>
              {[{label:'الدفع بالجنيه المصري', ids:['instapay','vodafone']}, {label:'الدفع بالدولار',ids:['paypal','paylater','card']}].map(group=><fieldset key={group.label} className="mt-6"><legend className="mb-3 flex w-full items-center gap-2 text-sm font-bold text-slate-700"><Banknote className="h-4 w-4 text-primary"/>{group.label}</legend><div role="radiogroup" aria-label={group.label} className="grid gap-3 sm:grid-cols-2">{methods.filter(m=>group.ids.includes(m.id) && (m.id !== 'paylater' || payLaterEligible)).map(m=><button key={m.id} type="button" role="radio" aria-checked={method===m.id} onClick={()=>selectMethod(m.id)} className={`relative flex min-h-[104px] w-full cursor-pointer items-center gap-3 rounded-2xl border-2 p-4 text-right transition focus:outline-none focus:ring-2 focus:ring-primary ${method===m.id?'border-primary bg-blue-50/60 shadow-sm':'border-slate-200 hover:border-slate-300'}`}><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2">{m.icon}<span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold" dir="ltr">{m.currency}</span></span><span className="mt-2 block text-xs text-slate-500">{m.description}</span></span><span aria-hidden="true" className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${method===m.id?'border-primary':'border-slate-400'}`}>{method===m.id&&<span className="h-2.5 w-2.5 rounded-full bg-primary"/>}</span></button>)}</div></fieldset>)}
            {error&&<p role="alert" className="mt-4 flex gap-2 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700"><AlertCircle className="h-5 w-5 shrink-0"/>{error}</p>}
             {method!=='paypal'&&method!=='paylater'&&method!=='card'&&<button onClick={submitManual} disabled={!method||busy} className="mt-6 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-5 text-base font-bold text-white shadow-lg shadow-blue-200 disabled:cursor-not-allowed disabled:opacity-50">{busy&&<Loader2 className="h-5 w-5 animate-spin"/>}{cta}</button>}
          </div>
        </section>
        <aside className="order-1 lg:sticky lg:top-24 lg:order-2"><div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 p-5 sm:p-6"><div className="flex items-center justify-between"><div><h2 className="text-lg font-bold">ملخص الطلب</h2><p className="mt-1 text-xs text-slate-500">{productCount} {productCount===1?'منتج':'منتجات'}</p></div><ShoppingBag className="h-6 w-6 text-primary"/></div></div><div className="max-h-64 space-y-4 overflow-y-auto p-5 lg:max-h-[42vh]">{items.map(item=>{const unit=currency==='USD'?getItemUsdUnitPrice(item,rate):getItemEgpUnitPrice(item,rate); return <div key={`${item.id}-${item.selectedDuration}`} className="flex gap-3"><div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-slate-100">{item.coverImageUrl?<img src={item.coverImageUrl} alt="" className="h-full w-full object-cover"/>:<span className="grid h-full place-items-center font-bold text-slate-400">{item.name[0]}</span>}<span className="absolute -left-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-slate-800 px-1 text-[10px] text-white">{item.quantity}</span></div><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-bold">{item.name}</h3><p className="mt-0.5 text-xs text-slate-500">{item.selectedDuration}</p>{item.description&&<p className="mt-1 line-clamp-1 text-[11px] text-slate-400">{item.description}</p>}</div><strong className="shrink-0 text-sm" dir="ltr">{(unit*item.quantity).toFixed(2)} {currency}</strong></div>})}</div>
          <div className="border-t border-slate-100 p-5 sm:p-6"><div className="flex gap-2"><input value={promoInput} onChange={e=>setPromoInput(e.target.value)} placeholder="كود الخصم" className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-200 px-3"/><button onClick={applyPromo} disabled={promo.status==='loading'} className="min-h-11 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white">تطبيق</button></div>{promo.status==='valid'&&<p className="mt-2 text-xs font-bold text-emerald-700">تم تطبيق خصم {promo.percentage}%</p>}{promo.status==='invalid'&&<p className="mt-2 text-xs text-red-600">الكود غير صالح أو لا ينطبق على هذه المنتجات.</p>}
          {isSignedIn&&availableCashback>0&&<div className="mt-3 flex gap-2"><input value={cashbackInput} onChange={e=>setCashbackInput(e.target.value)} type="number" min="0" max={availableCashback} placeholder={`كاش باك متاح: ${availableCashback.toFixed(2)}`} className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-200 px-3"/><button onClick={()=>{const n=Number(cashbackInput); if(n>0&&n<=availableCashback&&n<=beforeCashback){setCashbackUsed(Math.round(n*100)/100);setError('')}else setError('قيمة الكاش باك غير صالحة.')}} className="rounded-xl border px-4 text-sm font-bold">استخدام</button></div>}
           <dl className="mt-5 space-y-3 text-sm"><div className="flex justify-between"><dt className="text-slate-500">الإجمالي الفرعي</dt><dd dir="ltr">{subtotal.toFixed(2)} {currency}</dd></div>{discount>0&&<div className="flex justify-between text-emerald-700"><dt>الخصم</dt><dd dir="ltr">-{discount.toFixed(2)} {currency}</dd></div>}{cashbackUsed>0&&<div className="flex justify-between text-emerald-700"><dt>الكاش باك المستخدم</dt><dd dir="ltr">-{cashbackUsed.toFixed(2)} {currency}</dd></div>}<div className="flex justify-between border-t pt-4 text-lg font-black"><dt>الإجمالي النهائي</dt><dd dir="ltr">{total.toFixed(2)} {currency}</dd></div><div className="flex justify-between text-xs text-slate-500"><dt>كاش باك متوقع</dt><dd dir="ltr">{(total*.05).toFixed(2)} {currency}</dd></div></dl></div></div>{automaticPaymentPanel}</aside>
      </div>
    </div>
  </main></Layout>;
}
