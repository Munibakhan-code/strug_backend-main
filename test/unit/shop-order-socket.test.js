import { describe, it, expect, vi } from 'vitest';
import {
  foodCompatibleOrderStatus,
  emitProductOrderStatusUpdate,
} from '../../utils/shop-order-socket.js';

describe('foodCompatibleOrderStatus', () => {
  it('maps product statuses to Food tracking keys', () => {
    expect(foodCompatibleOrderStatus('driver_assigned')).toBe('preparing');
    expect(foodCompatibleOrderStatus('fulfilled')).toBe('delivered');
    expect(foodCompatibleOrderStatus('confirmed')).toBe('confirmed');
  });
});

describe('emitProductOrderStatusUpdate', () => {
  it('emits Food-compatible and legacy events to the buyer room', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const io = { to };

    emitProductOrderStatusUpdate(io, { order_id: 42, buyer_id: 7 }, {
      status: 'picked_up',
      driver_id: 3,
    });

    expect(to).toHaveBeenCalledWith('user-7');
    expect(emit).toHaveBeenCalledWith('order-status-update-42', {
      order_status: 'picked_up',
      status: 'picked_up',
      driver_id: 3,
    });
    expect(emit).toHaveBeenCalledWith('order-status-42', { status: 'picked_up', driver_id: 3 });
  });

  it('no-ops without io, order id, or status', () => {
    const io = { to: vi.fn() };
    emitProductOrderStatusUpdate(null, { order_id: 1, buyer_id: 2 }, { status: 'confirmed' });
    emitProductOrderStatusUpdate(io, { buyer_id: 2 }, { status: 'confirmed' });
    emitProductOrderStatusUpdate(io, { order_id: 1, buyer_id: 2 }, {});
    expect(io.to).not.toHaveBeenCalled();
  });
});
