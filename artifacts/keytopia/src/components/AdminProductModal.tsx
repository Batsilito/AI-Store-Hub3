import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronDown, ChevronUp, Upload, ImageIcon, Plus } from 'lucide-react';
import {
  Product,
  ProductInput,
  useCreateProduct,
  useUpdateProduct,
  useListCategories,
  getListAdminProductsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  product?: Product | null;
  onProductSaved?: () => void;
}

const DURATION_OPTIONS = ['1 Month', '3 Months', '6 Months', '12 Months', 'Lifetime'];
const ACTIVATION_OPTIONS = ['', 'Automatic', 'Manual', 'Invitation'];
const CUSTOMER_INFO_OPTIONS = [
  { key: 'email',       label: 'Email' },
  { key: 'password',    label: 'Password' },
  { key: 'username',    label: 'Username' },
  { key: 'inviteEmail', label: 'Invite Email' },
  { key: 'notes',       label: 'Notes' },
];
const AVAILABILITY_OPTIONS = ['in_stock', 'low_stock', 'out_of_stock', 'coming_soon'] as const;
const BADGE_OPTIONS = ['best_seller', 'new', 'flash_sale', 'limited_stock', 'popular', 'best_value'] as const;

type Section = 'basic' | 'pricing' | 'subscription' | 'description' | 'customer' | 'afterpurchase';

function SectionHeader({
  title, open, onToggle,
}: { title: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between py-3 text-left group"
    >
      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground group-hover:text-foreground transition-colors">
        {title}
      </span>
      {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
    </button>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-muted-foreground mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

const inputCls = "w-full bg-muted border-none rounded-[10px] px-3 py-2.5 text-sm text-foreground focus:ring-2 focus:ring-primary outline-none transition-all";
const checkboxCls = "w-4 h-4 rounded border-muted-foreground/30 text-primary focus:ring-primary";

function CategorySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: categories } = useListCategories();
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={inputCls}
    >
      <option value="">— No category —</option>
      {categories?.map(c => (
        <option key={c.id} value={c.name}>{c.name}</option>
      ))}
    </select>
  );
}

type PricingRow = { duration: string; price: string; salePrice: string; priceUsd: string; salePriceUsd: string };

type FormData = {
  name: string; category: string; brand: string; coverImageUrl: string;
  pricingOptions: PricingRow[];
  deliveryTime: string; activationType: string;
  onCustomerAccount: boolean; invitationLink: string; licenseKey: string; sharedAccount: boolean;
  description: string; featuresText: string; warrantyDuration: string;
  customerInfoRequired: string[];
  afterPurchaseInstructions: string;
  availability: Product['availability']; badges: Product['badges'];
};

const EMPTY_PRICING: PricingRow = { duration: '1 Month', price: '', salePrice: '', priceUsd: '', salePriceUsd: '' };

const EMPTY: FormData = {
  name: '', category: '', brand: '', coverImageUrl: '',
  pricingOptions: [{ ...EMPTY_PRICING }],
  deliveryTime: '', activationType: '',
  onCustomerAccount: false, invitationLink: '', licenseKey: '', sharedAccount: false,
  description: '', featuresText: '', warrantyDuration: '',
  customerInfoRequired: [],
  afterPurchaseInstructions: '',
  availability: 'in_stock', badges: [],
};

function productToForm(p: Product): FormData {
  const pricingOptions: PricingRow[] = (
    p.pricingOptions && p.pricingOptions.length > 0
      ? p.pricingOptions
      : [{ duration: p.duration, price: p.price, salePrice: p.salePrice ?? null, priceUsd: p.priceUsd ?? null, salePriceUsd: p.salePriceUsd ?? null }]
  ).map(o => ({
    duration: o.duration,
    price: String(o.price),
    salePrice: o.salePrice != null ? String(o.salePrice) : '',
    priceUsd: o.priceUsd != null ? String(o.priceUsd) : '',
    salePriceUsd: o.salePriceUsd != null ? String(o.salePriceUsd) : '',
  }));
  return {
    name: p.name,
    category: p.category ?? '',
    brand: p.brand ?? '',
    coverImageUrl: p.coverImageUrl ?? '',
    pricingOptions,
    deliveryTime: p.deliveryTime ?? '',
    activationType: p.activationType ?? '',
    onCustomerAccount: p.onCustomerAccount ?? false,
    invitationLink: p.invitationLink ?? '',
    licenseKey: p.licenseKey ?? '',
    sharedAccount: p.sharedAccount ?? false,
    description: p.description ?? '',
    featuresText: (p.features ?? []).join('\n'),
    warrantyDuration: p.warrantyDuration ?? '',
    customerInfoRequired: p.customerInfoRequired ?? [],
    afterPurchaseInstructions: p.afterPurchaseInstructions ?? '',
    availability: p.availability ?? 'in_stock', badges: p.badges ?? [],
  };
}

function formToInput(f: FormData): ProductInput {
  const pricingOptions = f.pricingOptions
    .filter(o => o.duration && o.price)
    .map(o => ({
      duration: o.duration,
      price: Number(o.price),
      salePrice: o.salePrice ? Number(o.salePrice) : null,
      priceUsd: o.priceUsd ? Number(o.priceUsd) : null,
      salePriceUsd: o.salePriceUsd ? Number(o.salePriceUsd) : null,
    }));
  const first = pricingOptions[0] ?? { duration: '1 Month', price: 0, salePrice: null, priceUsd: null, salePriceUsd: null };
  return {
    name: f.name,
    category: f.category || undefined,
    brand: f.brand || undefined,
    coverImageUrl: f.coverImageUrl || undefined,
    price: first.price,
    salePrice: first.salePrice ?? undefined,
    priceUsd: first.priceUsd ?? undefined,
    salePriceUsd: first.salePriceUsd ?? undefined,
    duration: first.duration,
    pricingOptions,
    deliveryTime: f.deliveryTime || undefined,
    activationType: f.activationType || undefined,
    onCustomerAccount: f.onCustomerAccount,
    invitationLink: f.invitationLink || undefined,
    licenseKey: f.licenseKey || undefined,
    sharedAccount: f.sharedAccount,
    description: f.description || undefined,
    features: f.featuresText
      ? f.featuresText.split('\n').map(s => s.trim()).filter(Boolean)
      : undefined,
    warrantyDuration: f.warrantyDuration || undefined,
    customerInfoRequired: f.customerInfoRequired.length ? f.customerInfoRequired : undefined,
    afterPurchaseInstructions: f.afterPurchaseInstructions || undefined,
    availability: f.availability,
    badges: f.badges,
  };
}

// ── Inline image uploader ─────────────────────────────────────────────────
function ImageUploader({
  value, onChange,
}: { value: string; onChange: (url: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) { setErr('Please select an image file.'); return; }
    if (file.size > 8 * 1024 * 1024) { setErr('Please select an image smaller than 8 MB.'); return; }
    setErr(''); setUploading(true);
    try {
      const response = await fetch('/api/storage/uploads/direct', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      const body = await response.json().catch(() => null) as
        | { objectPath?: string; error?: string }
        | null;
      if (!response.ok || !body?.objectPath) {
        throw new Error(body?.error || 'Failed to upload image');
      }
      onChange(`/api/storage${body.objectPath}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <input ref={inputRef} type="file" accept="image/*" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
      {value ? (
        <div className="relative rounded-[10px] overflow-hidden h-36 bg-muted group">
          <img src={value} alt="Product" className="w-full h-full object-cover" />
          <button type="button" onClick={() => inputRef.current?.click()}
            className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 text-white text-sm font-semibold">
            <Upload className="w-4 h-4" /> Change Image
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading}
          className="w-full h-28 rounded-[10px] border-2 border-dashed border-muted-foreground/20 hover:border-primary/40 bg-muted hover:bg-primary/5 flex flex-col items-center justify-center gap-2 transition-all disabled:opacity-50">
          {uploading
            ? <><div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" /><span className="text-xs text-muted-foreground">Uploading…</span></>
            : <><ImageIcon className="w-6 h-6 text-muted-foreground/50" /><span className="text-xs text-muted-foreground">Click to upload image</span></>}
        </button>
      )}
      {err && <p className="text-[11px] text-destructive mt-1">{err}</p>}
    </div>
  );
}

export default function AdminProductModal({ isOpen, onClose, product, onProductSaved }: Props) {
  const isEditing = !!product;
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormData>(EMPTY);
  const [open, setOpen] = useState<Record<Section, boolean>>({
    basic: true, pricing: true, subscription: true,
    description: true, customer: true, afterpurchase: true,
  });

  useEffect(() => {
    if (isOpen) setForm(product ? productToForm(product) : EMPTY);
  }, [product, isOpen]);

  const toggle = (s: Section) => setOpen(prev => ({ ...prev, [s]: !prev[s] }));
  const set = (patch: Partial<FormData>) => setForm(prev => ({ ...prev, ...patch }));
  const toggleInfo = (key: string) =>
    set({
      customerInfoRequired: form.customerInfoRequired.includes(key)
        ? form.customerInfoRequired.filter(k => k !== key)
        : [...form.customerInfoRequired, key],
    });

  // Pricing option helpers
  const updateOption = (i: number, field: keyof PricingRow, value: string) =>
    set({ pricingOptions: form.pricingOptions.map((o, idx) => idx === i ? { ...o, [field]: value } : o) });
  const addOption = () => set({ pricingOptions: [...form.pricingOptions, { ...EMPTY_PRICING }] });
  const removeOption = (i: number) =>
    set({ pricingOptions: form.pricingOptions.filter((_, idx) => idx !== i) });

  const onSuccess = (msg: string) => {
    queryClient.invalidateQueries({ queryKey: getListAdminProductsQueryKey() });
    toast.success(msg);
    onProductSaved?.();
    onClose();
  };

  const createMutation = useCreateProduct({
    mutation: { onSuccess: () => onSuccess('Product created'), onError: () => toast.error('Failed to create') },
  });
  const updateMutation = useUpdateProduct({
    mutation: { onSuccess: () => onSuccess('Product updated'), onError: () => toast.error('Failed to update') },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const data = formToInput(form);
    if (isEditing && product) {
      updateMutation.mutate({ id: product.id, data });
    } else {
      createMutation.mutate({ data });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 20 }}
            onClick={e => e.stopPropagation()}
            className="bg-card w-full max-w-2xl rounded-[20px] shadow-2xl overflow-hidden max-h-[92vh] flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-black/[0.05] shrink-0">
              <h2 className="text-lg font-display font-bold">{isEditing ? 'Edit Product' : 'Add Product'}</h2>
              <button onClick={onClose} className="p-2 rounded-full hover:bg-muted transition-colors text-muted-foreground">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-2">
              <form id="product-form" onSubmit={handleSubmit} className="divide-y divide-black/[0.04]">

                {/* ── Basic Information ── */}
                <div className="py-2">
                  <SectionHeader title="Basic Information" open={open.basic} onToggle={() => toggle('basic')} />
                  {open.basic && (
                    <div className="grid grid-cols-2 gap-3 pb-3">
                      <div className="col-span-2">
                        <Field label="Product Name *">
                          <input type="text" required value={form.name} onChange={e => set({ name: e.target.value })} className={inputCls} />
                        </Field>
                      </div>
                      <Field label="Category">
                        <CategorySelect value={form.category} onChange={v => set({ category: v })} />
                      </Field>
                      <Field label="Brand">
                        <input type="text" placeholder="e.g. OpenAI" value={form.brand} onChange={e => set({ brand: e.target.value })} className={inputCls} />
                      </Field>
                      <Field label="Availability">
                        <select value={form.availability} onChange={e => set({ availability: e.target.value as FormData['availability'] })} className={inputCls}>
                          {AVAILABILITY_OPTIONS.map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
                        </select>
                      </Field>
                      <div className="col-span-2">
                        <Field label="Store badges">
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {BADGE_OPTIONS.map(badge => <label key={badge} className="flex gap-2 items-center text-sm capitalize"><input type="checkbox" checked={form.badges.includes(badge)} onChange={() => set({ badges: form.badges.includes(badge) ? form.badges.filter(item => item !== badge) : [...form.badges, badge] })} className={checkboxCls} />{badge.replaceAll('_', ' ')}</label>)}
                          </div>
                        </Field>
                      </div>
                      <div className="col-span-2">
                        <Field label="Product Image">
                          <ImageUploader
                            value={form.coverImageUrl}
                            onChange={url => set({ coverImageUrl: url })}
                          />
                        </Field>
                      </div>
                    </div>
                  )}
                </div>

                {/* ── Pricing & Duration ── */}
                <div className="py-2">
                  <SectionHeader title="Pricing & Duration" open={open.pricing} onToggle={() => toggle('pricing')} />
                  {open.pricing && (
                    <div className="flex flex-col gap-2 pb-3">
                      {form.pricingOptions.map((opt, i) => (
                        <div key={i} className="bg-muted/70 rounded-[12px] p-3 relative">
                          {form.pricingOptions.length > 1 && (
                            <button type="button" onClick={() => removeOption(i)}
                              className="absolute top-2 end-2 text-muted-foreground hover:text-destructive transition-colors">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                            <div>
                              <label className="text-[11px] font-semibold text-muted-foreground mb-1 block">Duration *</label>
                              <input
                                type="text"
                                placeholder="e.g. 1 Month, Lifetime"
                                value={opt.duration}
                                onChange={e => updateOption(i, 'duration', e.target.value)}
                                className={inputCls}
                              />
                            </div>
                            <div>
                              <label className="text-[11px] font-semibold text-muted-foreground mb-1 block">Price (EGP) *</label>
                              <input type="number" min="0" step="0.01" required={i === 0} value={opt.price}
                                onChange={e => updateOption(i, 'price', e.target.value)} className={inputCls} />
                            </div>
                            <div>
                              <label className="text-[11px] font-semibold text-muted-foreground mb-1 block">Sale Price</label>
                              <input type="number" min="0" step="0.01" value={opt.salePrice}
                                onChange={e => updateOption(i, 'salePrice', e.target.value)} className={inputCls} />
                            </div>
                            <div>
                              <label className="text-[11px] font-semibold text-muted-foreground mb-1 block">Price (USD)</label>
                              <input type="number" min="0" step="0.01" value={opt.priceUsd}
                                onChange={e => updateOption(i, 'priceUsd', e.target.value)} className={inputCls} />
                            </div>
                            <div>
                              <label className="text-[11px] font-semibold text-muted-foreground mb-1 block">Sale USD</label>
                              <input type="number" min="0" step="0.01" value={opt.salePriceUsd}
                                onChange={e => updateOption(i, 'salePriceUsd', e.target.value)} className={inputCls} />
                            </div>
                          </div>
                        </div>
                      ))}
                      <button type="button" onClick={addOption}
                        className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/70 transition-colors py-1 mt-1">
                        <Plus className="w-3.5 h-3.5" /> Add Duration Option
                      </button>
                    </div>
                  )}
                </div>

                {/* ── Subscription ── */}
                <div className="py-2">
                  <SectionHeader title="Subscription" open={open.subscription} onToggle={() => toggle('subscription')} />
                  {open.subscription && (
                    <div className="grid grid-cols-2 gap-3 pb-3">
                      <Field label="Delivery Time" hint="e.g. 5–30 minutes">
                        <input type="text" placeholder="5–30 minutes" value={form.deliveryTime} onChange={e => set({ deliveryTime: e.target.value })} className={inputCls} />
                      </Field>
                      <Field label="Activation Type">
                        <select value={form.activationType} onChange={e => set({ activationType: e.target.value })} className={inputCls}>
                          {ACTIVATION_OPTIONS.map(o => <option key={o} value={o}>{o || '— Select —'}</option>)}
                        </select>
                      </Field>
                      <Field label="Invitation Link">
                        <input type="url" placeholder="https://..." value={form.invitationLink} onChange={e => set({ invitationLink: e.target.value })} className={inputCls} />
                      </Field>
                      <div className="col-span-2">
                        <Field label="License Key">
                          <input type="text" value={form.licenseKey} onChange={e => set({ licenseKey: e.target.value })} className={inputCls} />
                        </Field>
                      </div>
                      <label className="flex items-center gap-2.5 cursor-pointer text-sm">
                        <input type="checkbox" checked={form.onCustomerAccount} onChange={e => set({ onCustomerAccount: e.target.checked })} className={checkboxCls} />
                        On Customer Account
                      </label>
                      <label className="flex items-center gap-2.5 cursor-pointer text-sm">
                        <input type="checkbox" checked={form.sharedAccount} onChange={e => set({ sharedAccount: e.target.checked })} className={checkboxCls} />
                        Shared Account
                      </label>
                    </div>
                  )}
                </div>

                {/* ── Description ── */}
                <div className="py-2">
                  <SectionHeader title="Description" open={open.description} onToggle={() => toggle('description')} />
                  {open.description && (
                    <div className="flex flex-col gap-3 pb-3">
                      <Field label="Short Description">
                        <textarea rows={3} value={form.description} onChange={e => set({ description: e.target.value })} className={`${inputCls} resize-none`} />
                      </Field>
                      <Field label="Features" hint="One feature per line">
                        <textarea rows={5} placeholder={"Access to GPT-4o\nImage generation\nAdvanced reasoning"} value={form.featuresText} onChange={e => set({ featuresText: e.target.value })} className={`${inputCls} resize-none font-mono text-xs`} />
                      </Field>
                      <Field label="Warranty Duration" hint="e.g. 30 days, 3 months, Lifetime">
                        <input type="text" placeholder="30 days" value={form.warrantyDuration} onChange={e => set({ warrantyDuration: e.target.value })} className={inputCls} />
                      </Field>
                    </div>
                  )}
                </div>

                {/* ── Customer Information Required ── */}
                <div className="py-2">
                  <SectionHeader title="Customer Information Required" open={open.customer} onToggle={() => toggle('customer')} />
                  {open.customer && (
                    <div className="pb-3">
                      <p className="text-xs text-muted-foreground mb-3">Select what the customer must provide when ordering:</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-2.5 gap-x-4">
                        {CUSTOMER_INFO_OPTIONS.map(({ key, label }) => (
                          <label key={key} className="flex items-center gap-2.5 cursor-pointer text-sm">
                            <input
                              type="checkbox"
                              checked={form.customerInfoRequired.includes(key)}
                              onChange={() => toggleInfo(key)}
                              className={checkboxCls}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* ── After Purchase Instructions ── */}
                <div className="py-2">
                  <SectionHeader title="After Purchase Instructions" open={open.afterpurchase} onToggle={() => toggle('afterpurchase')} />
                  {open.afterpurchase && (
                    <div className="pb-3">
                      <p className="text-xs text-muted-foreground mb-2">Instructions shown to the customer after payment.</p>
                      <textarea
                        rows={6}
                        placeholder={"1. Create a Google account.\n2. Send us your email.\n3. Wait 5 to 30 minutes for activation."}
                        value={form.afterPurchaseInstructions}
                        onChange={e => set({ afterPurchaseInstructions: e.target.value })}
                        className={`${inputCls} resize-none`}
                      />
                    </div>
                  )}
                </div>

              </form>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-black/[0.05] bg-background shrink-0">
              <button
                type="submit"
                form="product-form"
                disabled={isPending}
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold py-3.5 rounded-[14px] transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isPending ? 'Saving…' : isEditing ? 'Save Changes' : 'Add Product'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
