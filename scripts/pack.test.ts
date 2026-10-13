import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PackLifecycle } from '../src/ui/PackLifecycle.ts';

// A real transaction ledger: each successful tear debits one pack and awards one card.
function packLedger() {
  const ledger = { stones: 200, owned: [] as string[], revealed: [] as string[], closes: 0, attempts: 0 };
  const pack = new PackLifecycle<string>({
    onTear() {
      ledger.attempts++;
      if (ledger.stones < 100) return null;
      ledger.stones -= 100;
      ledger.owned.push('linchong');
      return 'linchong';
    },
    onReveal(card) { ledger.revealed.push(card); },
    onClose() { ledger.closes++; },
  });
  return { pack, ledger };
}

test('duplicate tear inputs debit and award only one pack', () => {
  const { pack, ledger } = packLedger();
  pack.commit();
  pack.commit();
  assert.equal(ledger.stones, 100);
  assert.deepEqual(ledger.owned, ['linchong']);
  assert.equal(ledger.attempts, 1);
});

test('closing the free preview prevents a later tear from charging', () => {
  const { pack, ledger } = packLedger();
  pack.close();
  pack.commit();
  pack.close();
  assert.equal(ledger.stones, 200);
  assert.deepEqual(ledger.owned, []);
  assert.deepEqual(ledger.revealed, []);
  assert.equal(ledger.closes, 1);
});

test('closing mid-animation delivers the award before close, exactly once', () => {
  const events: string[] = [];
  const pack = new PackLifecycle({ onTear: () => 'linchong', onReveal: (card) => { events.push(card); }, onClose: () => { events.push('closed'); } });
  pack.commit();
  pack.close();
  pack.reveal();
  pack.close();
  assert.deepEqual(events, ['linchong', 'closed']);
});

test('normal animation reveal and subsequent close never duplicate the delivered card', () => {
  const { pack, ledger } = packLedger();
  pack.reveal();
  assert.deepEqual(ledger.revealed, []);
  pack.commit();
  pack.reveal();
  pack.reveal();
  pack.close();
  assert.deepEqual(ledger.revealed, ['linchong']);
  assert.equal(ledger.closes, 1);
});

test('reentrant close during tear waits for the synchronous transaction result', () => {
  const events: string[] = [];
  const pack = new PackLifecycle<string>({
    onTear: () => { pack.close(); return 'wusong'; },
    onReveal: (card) => { events.push(card); pack.close(); },
    onClose: () => { events.push('closed'); },
  });
  pack.commit();
  pack.commit();
  assert.deepEqual(events, ['wusong', 'closed']);
});

test('reentrant tear is rejected before the transaction callback runs again', () => {
  let charges = 0;
  const pack = new PackLifecycle<string>({
    onTear: () => { charges++; pack.commit(); return 'wusong'; },
    onReveal: () => {}, onClose: () => {},
  });
  pack.commit();
  assert.equal(charges, 1);
});

test('insufficient balance has no result and cannot retry the same opened pack', () => {
  const { pack, ledger } = packLedger();
  ledger.stones = 0;
  pack.commit();
  pack.commit();
  pack.close();
  assert.equal(ledger.attempts, 1);
  assert.deepEqual(ledger.owned, []);
  assert.deepEqual(ledger.revealed, []);
});
