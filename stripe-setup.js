#!/usr/bin/env node
// stripe-setup.js — Run ONCE to create LoveFlix products and prices in Stripe.
//
// Usage:
//   STRIPE_SECRET_KEY=sk_live_... node stripe-setup.js
//
// After running, paste the printed vars into wrangler.toml under [vars].

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Error: set STRIPE_SECRET_KEY env var before running.');
  process.exit(1);
}
if (!key.startsWith('sk_')) {
  console.error('Error: STRIPE_SECRET_KEY must start with sk_live_ or sk_test_');
  process.exit(1);
}

const stripePost = (path, params) =>
  fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  }).then(r => r.json());

const plans = [
  {
    id: 'crush',
    name: 'Crush',
    description: 'For new couples — 25 videos, 1080p streaming, 2 profiles.',
    monthly: 600,   // $6.00
    yearly: 4800,   // $48.00 ($4/mo)
  },
  {
    id: 'sweetheart',
    name: 'Sweetheart',
    description: 'For real couples — unlimited videos, 4K HDR, custom subdomain.',
    monthly: 1200,  // $12.00
    yearly: 10800,  // $108.00 ($9/mo)
  },
  {
    id: 'forever',
    name: 'Forever',
    description: 'For the long haul — unlimited everything, custom domain, 6 profiles.',
    monthly: 2400,  // $24.00
    yearly: 21600,  // $216.00 ($18/mo)
  },
];

async function main() {
  console.log(`\nConnecting to Stripe (${key.startsWith('sk_live') ? 'LIVE' : 'TEST'} mode)...\n`);

  const result = {};

  for (const plan of plans) {
    console.log(`Creating product: LoveFlix ${plan.name}`);

    const product = await stripePost('/products', {
      name: `LoveFlix ${plan.name}`,
      description: plan.description,
      'metadata[plan_id]': plan.id,
    });
    if (product.error) {
      console.error(`  ERROR: ${product.error.message}`);
      process.exit(1);
    }
    console.log(`  Product ID: ${product.id}`);

    const monthly = await stripePost('/prices', {
      product: product.id,
      unit_amount: plan.monthly,
      currency: 'usd',
      'recurring[interval]': 'month',
      nickname: `${plan.name} Monthly`,
      'metadata[plan_id]': plan.id,
      'metadata[billing]': 'monthly',
    });
    if (monthly.error) {
      console.error(`  ERROR (monthly): ${monthly.error.message}`);
      process.exit(1);
    }
    console.log(`  Monthly price: ${monthly.id}  ($${plan.monthly / 100}/mo)`);

    const yearly = await stripePost('/prices', {
      product: product.id,
      unit_amount: plan.yearly,
      currency: 'usd',
      'recurring[interval]': 'year',
      nickname: `${plan.name} Yearly`,
      'metadata[plan_id]': plan.id,
      'metadata[billing]': 'yearly',
    });
    if (yearly.error) {
      console.error(`  ERROR (yearly): ${yearly.error.message}`);
      process.exit(1);
    }
    console.log(`  Yearly price:  ${yearly.id}  ($${plan.yearly / 100}/yr)\n`);

    result[plan.id] = { monthly: monthly.id, yearly: yearly.id };
  }

  console.log('='.repeat(60));
  console.log('SUCCESS! Paste these into wrangler.toml under [vars]:\n');
  for (const [id, prices] of Object.entries(result)) {
    const u = id.toUpperCase();
    console.log(`STRIPE_PRICE_${u}_MONTHLY = "${prices.monthly}"`);
    console.log(`STRIPE_PRICE_${u}_YEARLY  = "${prices.yearly}"`);
  }
  console.log('\nThen run:');
  console.log('  wrangler pages secret put STRIPE_SECRET_KEY');
  console.log('  wrangler deploy');
  console.log('='.repeat(60));
}

main().catch(e => { console.error(e); process.exit(1); });
