import { Actor, log } from 'apify';

/**
 * Buffers dataset rows and pushes/charges them in batches.
 * One pushData + one Actor.charge({count}) per event per batch instead of 2 API calls per row,
 * which cuts run time (and platform cost) on large inputs by ~10x.
 * Rows are always saved before they are charged; rows with event=null (errors) are never charged.
 */
export class Emitter {
    private buf: { row: object; events: string[] }[] = [];
    /** Events charged successfully (as reported by the SDK), per event name. */
    readonly charged: Record<string, number> = {};
    /** Events queued in the buffer but not yet charged. */
    pending(eventName: string): number {
        return this.buf.reduce((n, b) => n + b.events.filter((e) => e === eventName).length, 0);
    }

    private ppe: boolean | null = null;
    limitReached = false;

    constructor(private readonly batchSize = 100) {}

    /** events: one event name, several (charged once each), or null for rows that are never charged. */
    async emit(row: object, event: string | string[] | null): Promise<void> {
        let events: string[] = [];
        if (Array.isArray(event)) events = event;
        else if (event !== null) events = [event];
        this.buf.push({ row, events });
        if (this.buf.length >= this.batchSize) await this.flush();
    }

    async flush(): Promise<void> {
        if (!this.buf.length) return;
        const batch = this.buf;
        this.buf = [];
        await Actor.pushData(batch.map((b) => b.row));
        if (!this.isPpe()) return;
        const counts = new Map<string, number>();
        for (const b of batch) for (const e of b.events) counts.set(e, (counts.get(e) ?? 0) + 1);
        for (const [eventName, count] of counts) {
            try {
                const res = await Actor.charge({ eventName, count });
                this.charged[eventName] = (this.charged[eventName] ?? 0) + res.chargedCount;
                if (res.eventChargeLimitReached) {
                    log.warning(`Charge limit reached for ${eventName}`);
                    this.limitReached = true;
                }
            } catch (e) {
                log.debug(`Actor.charge failed for ${eventName}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    isPpe(): boolean {
        if (this.ppe === null) {
            try {
                this.ppe = Actor.getChargingManager().getPricingInfo().isPayPerEvent;
            } catch {
                this.ppe = false;
            }
        }
        return this.ppe;
    }
}
