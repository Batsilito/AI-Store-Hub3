export type PayPalApprovalData = { orderId?: string };

export type PayPalSessionCallbacks = {
  onApprove: (data: PayPalApprovalData) => Promise<void>;
  onCancel?: (data?: { orderId?: string }) => void;
  onError?: (error: unknown) => void;
  onComplete?: (data?: unknown) => void;
};

type PayPalSessionLifecycleHandlers = {
  onApprove: (paypalOrderId: string) => Promise<void>;
  onMissingOrderId: () => void;
  onCancel: (data?: { orderId?: string }) => void;
  onError: (error: unknown) => void;
};

/**
 * Keeps PayPal's hosted-session resolution separate from approval.
 * `start` only starts the hosted flow; capture belongs to `onApprove`.
 */
export function createPayPalSessionLifecycle(handlers: PayPalSessionLifecycleHandlers) {
  let approved = false;
  let started = false;

  const callbacks: PayPalSessionCallbacks = {
    onApprove: async (data) => {
      approved = true;
      if (!data?.orderId) {
        handlers.onMissingOrderId();
        return;
      }
      await handlers.onApprove(data.orderId);
    },
    onCancel: (data) => {
      if (approved) return;
      started = false;
      handlers.onCancel(data);
    },
    onError: (error) => {
      if (!approved) started = false;
      handlers.onError(error);
    },
  };

  return {
    callbacks,
    start: (startSession: () => Promise<void>) => {
      started = true;
      return startSession();
    },
    isApproved: () => approved,
    isStarted: () => started,
  };
}