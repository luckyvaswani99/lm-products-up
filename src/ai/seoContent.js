import OpenAI from 'openai';
import { config, requireKeys } from '../config.js';
import { buildProductDescription } from '../descriptions/productDescription.js';

let _client;
function client() {
  requireKeys([{ name: 'DEEPSEEK_API_KEY', value: config.deepseek.apiKey }]);
  if (!_client)
    _client = new OpenAI({ apiKey: config.deepseek.apiKey, baseURL: config.deepseek.baseURL });
  return _client;
}

const SYSTEM = `You write accurate, useful IndiaMART medicine copy for individual customers and business buyers.
Use supplied source fields as the authority for product identity, brand, strength, composition, manufacturer and
packaging. For Uses, How It Works, Common Side Effects and Safety only, you may use well-established general
pharmacology of the explicitly supplied active ingredient. Do not infer an ingredient that is not supplied.
Never provide dosage instructions, promises of efficacy, duration claims, diagnosis, suitability for a specific
person, certifications, quality/authenticity claims, storage or shipping promises. Keep medical wording cautious,
educational and prescription-focused. Always return STRICT JSON only.`;

function stripSupplierName(value) {
  const supplierName = String(config.supplier.name || '').trim();
  if (!supplierName) return String(value || '').trim();
  const escaped = supplierName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(value || '')
    .replace(new RegExp(`\\s*(?:[|,–—-]\\s*)?${escaped}\\s*$`, 'i'), '')
    .trim();
}

function specValue(specs, ...keys) {
  const wanted = keys.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [key, value] of Object.entries(specs || {})) {
    const normal = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (wanted.some((candidate) => normal === candidate) && value) return String(value).trim();
  }
  return '';
}

function sourceSpecsOnly(product) {
  return Object.fromEntries(
    Object.entries(product.specs || {})
      .map(([key, value]) => [String(key).trim(), String(value ?? '').trim()])
      .filter(([key, value]) => key && value),
  );
}

function buildUserPrompt(product) {
  const { supplier } = config;
  const specs = JSON.stringify(product.specs || {}, null, 0);
  const ingredient =
    product.compound ||
    specValue(
      product.specs,
      'Active Ingredient',
      'Product Composition',
      'Composition',
      'Drug Composition',
      'Salt Composition',
      'Salt',
    ) ||
    '(not supplied)';
  return `Create accurate IndiaMART SEO fields from this current scraped source record.

CURRENT SOURCE RECORD (authoritative for product identity and commercial facts)
- Name: ${product.name}
- Active ingredient/compound: ${ingredient}
- Price: ${product.price} per ${product.unit}
- Source description: ${product.description ? product.description.slice(0, 1500) : '(none supplied)'}
- Source specifications: ${specs}

SELLER IDENTITY (may be used only for seller name/location)
- ${supplier.name}, ${supplier.city}, ${supplier.state}

STRICT FACTUAL RULES
- Preserve source identity, brand, strength, form, composition, manufacturer and packaging exactly in meaning.
- Medical content may use established general knowledge only for the explicitly supplied active ingredient above.
- Do not provide a dose or schedule, promise results, recommend self-treatment, diagnose, or claim suitability.
- Do not invent duration, certifications (including WHO-GMP), quality/authenticity claims, storage instructions,
  dispatch times, international shipping, logistics, approvals, or seller/manufacturer capabilities.
- Uses must state recognized prescription indications cautiously. How It Works must explain the ingredient's real
  mechanism in plain language. Side effects must be common and non-exhaustive. Safety must include the most
  important ingredient-specific contraindications or urgent warning signs without replacing medical advice.
- Do not claim supply is limited to pharmacies or hospitals and do not write "Not for OTC sale".
- Never repeat product specs, manufacturer or packaging as prose sections; those already appear separately.

OUTPUT REQUIREMENTS
- "name": clean keyword-rich title (<=90 chars), retaining source brand, strength and form when present.
  Never include the seller/company name (${supplier.name}) in the product title.
- "description": useful medicine-specific HTML (roughly 900-2200 visible characters) using exactly these sections:
  1. <p><b>Uses</b></p> — recognized prescription uses in a substantive paragraph.
  2. <p><b>How [clean product name] Works</b></p> — explain the active ingredient's mechanism in plain language.
  3. <p><b>Common Side Effects</b></p> — 4-7 realistic common effects in a <ul> list.
  4. <p><b>Important Safety Information</b></p> — key contraindications, interactions, monitoring or urgent signs.
  Do not output Product Overview, Benefits/Highlights, Product Details, Quality Assurance, Packaging Information,
  Shipping/Delivery, seller promotion, or a repetition of the specifications. Use <p>, <b>, <ul> and <li> only.
- "metaTitle": <=60 chars and based only on source facts.
- "metaDescription": <=155 chars and based only on source facts plus seller city.
- "keywords": 6-10 relevant strings composed only from source terms and seller location.
- "specs": copy only the non-empty key/value pairs present in Source specifications. Do not add, rename,
  normalize, infer or default any specification, MOQ, delivery, origin, manufacturer, type, ideal-for value,
  packaging value or commercial detail that is absent from the source record.

Return ONLY a JSON object with exactly these keys: name, description, metaTitle,
metaDescription, keywords, specs.`;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('DeepSeek did not return valid JSON');
  }
}

/** Quick connectivity test for the DeepSeek text model. Throws on failure. */
export async function testSeo() {
  const resp = await client().chat.completions.create({
    model: config.deepseek.model,
    max_tokens: 1000,
    messages: [{ role: 'user', content: 'Reply with exactly these two words: PIPELINE OK' }],
  });
  const reply = resp.choices?.[0]?.message?.content?.trim() || '';
  if (!reply) {
    throw new Error(
      `model "${config.deepseek.model}" returned an EMPTY reply — the model id is probably wrong. ` +
        `Set DEEPSEEK_MODEL=deepseek-chat (or deepseek-reasoner) in .env.`,
    );
  }
  return { ok: true, model: config.deepseek.model, reply };
}

/** Generate SEO content for one product. Returns the seo object. */
export async function generateSeo(product) {
  const resp = await client().chat.completions.create({
    model: config.deepseek.model,
    temperature: 0.6,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildUserPrompt(product) },
    ],
  });
  const content = resp.choices?.[0]?.message?.content || '';
  const seo = safeParseJson(content);

  // Normalize search fields, then accept AI medicine copy only when it passes
  // the section/specificity/safety contract. Reviewed ingredient fallbacks
  // prevent weak, repetitive or unsupported copy from reaching IndiaMART.
  seo.name = stripSupplierName(seo.name || product.name).slice(0, 120);
  seo.metaTitle = (seo.metaTitle || seo.name).trim().slice(0, 70);
  seo.metaDescription = (seo.metaDescription || '').trim().slice(0, 170);
  if (typeof seo.keywords === 'string')
    seo.keywords = seo.keywords.split(',').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(seo.keywords)) seo.keywords = [];
  seo.specs = sourceSpecsOnly(product);
  seo.description = buildProductDescription(product, seo.description, seo.name);
  return seo;
}
