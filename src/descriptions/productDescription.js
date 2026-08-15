export const DESCRIPTION_MAX_CHARS = 3900;

const ALLOWED_TAGS = new Set(['p', 'strong', 'b', 'ul', 'li', 'br']);

function clean(value, max = 500) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeTextPreservingEntities(value) {
  return String(value || '')
    .replace(/&(?!(?:amp|lt|gt|quot|apos|nbsp|#39|#\d+|#x[\da-f]+);)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function specValue(specs, ...keys) {
  const wanted = keys.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [key, value] of Object.entries(specs || {})) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (wanted.includes(normalized) && clean(value)) return clean(value, 300);
  }
  return '';
}

function splitSourceList(value) {
  return clean(value, 1200)
    .split(/(?:\r?\n|\s*[•;]\s*)/)
    .map((item) => clean(item, 300))
    .filter(Boolean)
    .slice(0, 6);
}

function renderSection(title, { paragraphs = [], items = [] } = {}) {
  const body = [`<p><b>${escapeHtml(title)}</b></p>`];
  for (const paragraph of paragraphs.filter(Boolean)) body.push(`<p>${escapeHtml(paragraph)}</p>`);
  if (items.length) {
    body.push('<ul>');
    for (const item of items.filter(Boolean)) body.push(`<li>${escapeHtml(item)}</li>`);
    body.push('</ul>');
  }
  return body.join('');
}

function plainTextToHtml(value) {
  const lines = String(value || '').replace(/\r/g, '').split('\n');
  const output = [];
  let listOpen = false;

  const closeList = () => {
    if (listOpen) output.push('</ul>');
    listOpen = false;
  };

  for (const rawLine of lines) {
    const line = clean(rawLine, DESCRIPTION_MAX_CHARS);
    if (!line) {
      closeList();
      continue;
    }
    const bullet = line.match(/^[•*-]\s*(.+)$/);
    if (bullet) {
      if (!listOpen) output.push('<ul>');
      listOpen = true;
      output.push(`<li>${escapeHtml(bullet[1])}</li>`);
      continue;
    }
    closeList();
    const isHeading =
      line.length <= 100 &&
      /^(product overview|uses?|how .+ works|common side effects|important safety information|safety information|benefits?|key (?:features|details|information|highlights)|product details|quality assurance|packaging(?: & (?:storage|ordering))?|shipping & delivery|prescription notice|important):?$/i.test(line);
    output.push(isHeading ? `<p><b>${escapeHtml(line.replace(/:$/, ''))}</b></p>` : `<p>${escapeHtml(line)}</p>`);
  }
  closeList();
  return output.join('');
}

/** Remove scripts, attributes and every tag except the small TinyMCE allow-list. */
export function sanitizeDescriptionHtml(value) {
  let input = String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  if (!/<\/?(?:p|strong|ul|li|br)\b/i.test(input)) input = plainTextToHtml(input);

  return input
    .split(/(<[^>]*>)/g)
    .map((token) => {
      if (!token.startsWith('<')) return escapeTextPreservingEntities(token);
      const match = token.match(/^<\s*(\/?)\s*([a-z0-9]+)[^>]*>$/i);
      if (!match) return '';
      const closing = Boolean(match[1]);
      const tag = match[2].toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return '';
      if (tag === 'br') return '<br>';
      return closing ? `</${tag}>` : `<${tag}>`;
    })
    .join('')
    .trim();
}

/** Text used by IndiaMART's character counter; HTML markup is not counted. */
export function visibleDescriptionText(value) {
  return decodeEntities(
    String(value || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function descriptionVisibleLength(value) {
  return visibleDescriptionText(value).length;
}

/**
 * Match TinyMCE's saved markup closely enough to enforce IndiaMART's
 * "including formatting" counter before the form is submitted.
 */
export function descriptionFormattedLength(value) {
  const canonical = sanitizeDescriptionHtml(value)
    .replace(/<strong>/gi, '<b>')
    .replace(/<\/strong>/gi, '</b>')
    .replace(/(<\/p>|<ul>|<\/li>|<\/ul>)(?=<)/g, '$1\n');
  return canonical.length;
}

function limitDescriptionHtml(value, maxChars = DESCRIPTION_MAX_CHARS) {
  const safe = sanitizeDescriptionHtml(value);
  if (descriptionFormattedLength(safe) <= maxChars) return safe;

  // Oversized legacy/manual content is reduced safely. A binary search accounts
  // for entity expansion so the final HTML, not only visible text, stays <= max.
  const text = visibleDescriptionText(safe);
  const suffix = '…';
  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const shortened = text.slice(0, middle).trimEnd() + (middle < text.length ? suffix : '');
    const candidate = `<p>${escapeHtml(shortened)}</p>`;
    if (descriptionFormattedLength(candidate) <= maxChars) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/** Resolve the active ingredient without treating packaging/brand fields as medical facts. */
function activeIngredient(product) {
  const specs = { ...(product.specs || {}), ...(product.seo?.specs || {}) };
  return clean(
    product.compound ||
      specValue(
        specs,
        'Active Ingredient',
        'Product Composition',
        'Composition',
        'Drug Composition',
        'Salt Composition',
        'Salt',
      ),
    120,
  )
    .replace(/\bonly\b/gi, '')
    .trim();
}

const FORBIDDEN_DESCRIPTION_SECTIONS = new Set([
  'product overview',
  'benefits',
  'benefits & highlights',
  'product details',
  'packaging information',
  'packaging & storage',
  'shipping & delivery',
  'quality assurance',
]);

/** Return quality failures for AI/manual copy before it can reach IndiaMART. */
export function descriptionQualityIssues(product, value, displayName = '') {
  const safe = sanitizeDescriptionHtml(value);
  const visible = visibleDescriptionText(safe);
  const headings = [...safe.matchAll(/<p><b>(.*?)<\/b><\/p>/gi)].map((match) =>
    decodeEntities(match[1]).trim().toLowerCase(),
  );
  const issues = [];
  if (!headings.includes('uses')) issues.push('missing Uses section');
  const expectedName = clean(displayName || product.seo?.name || product.name, 180).toLowerCase();
  const expectedHowHeading = expectedName ? `how ${expectedName} works` : '';
  if (!expectedHowHeading || !headings.includes(expectedHowHeading)) {
    issues.push('missing exact product-name How It Works section');
  }
  if (!headings.includes('common side effects')) issues.push('missing Common Side Effects section');
  if (!headings.includes('important safety information')) issues.push('missing Important Safety Information section');
  const forbidden = headings.filter((heading) => FORBIDDEN_DESCRIPTION_SECTIONS.has(heading));
  if (forbidden.length) issues.push(`redundant section(s): ${forbidden.join(', ')}`);
  if (visible.length < 700) issues.push(`description is too thin (${visible.length} visible characters)`);
  if (visible.length > 3000) issues.push(`description is too long (${visible.length} visible characters)`);
  const ingredient = activeIngredient(product).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (ingredient && !visible.toLowerCase().replace(/[^a-z0-9]+/g, ' ').includes(ingredient)) {
    issues.push(`active ingredient ${activeIngredient(product)} is not explained`);
  }
  if ((safe.match(/<li>/gi) || []).length < 4) issues.push('fewer than four useful bullet points');
  if (/who[- ]?gmp|guaranteed|100% authentic|worldwide shipping|international shipping|temperature-controlled/i.test(visible)) {
    issues.push('contains unsupported quality or shipping claims');
  }
  return issues;
}

function tadalafilDescription(name) {
  return [
    renderSection('Uses', {
      paragraphs: [
        `${name} contains tadalafil, a prescription medicine commonly used for erectile dysfunction in adult men. Tadalafil may also be prescribed for urinary symptoms associated with benign prostatic hyperplasia, depending on the patient and the strength selected by the prescriber.`,
      ],
    }),
    renderSection(`How ${name} Works`, {
      paragraphs: [
        'Tadalafil is a phosphodiesterase type 5 (PDE5) inhibitor. It helps cyclic GMP remain active for longer, allowing smooth muscle in penile blood vessels to relax and increasing blood flow during sexual stimulation. It does not increase sexual desire and does not produce an erection without sexual stimulation.',
      ],
    }),
    renderSection('Common Side Effects', {
      items: [
        'Headache',
        'Facial flushing or warmth',
        'Indigestion or stomach discomfort',
        'Blocked or runny nose',
        'Back pain or muscle aches',
        'Dizziness',
      ],
    }),
    renderSection('Important Safety Information', {
      paragraphs: [
        'Do not use tadalafil with nitrate medicines for chest pain or with riociguat, because the combination can cause a dangerous fall in blood pressure. Tell the prescriber about heart disease, blood-pressure medicines, alpha-blockers, and liver or kidney problems.',
        'Seek urgent medical help for chest pain, an erection lasting more than four hours, or sudden loss of vision or hearing. This is a prescription product and should be used only in the strength and manner advised by a qualified healthcare professional.',
      ],
    }),
  ].join('');
}

function isotretinoinDescription(name) {
  return [
    renderSection('Uses', {
      paragraphs: [
        `${name} contains isotretinoin, an oral retinoid used under specialist supervision for severe acne that has not responded adequately to standard treatments such as topical medicines or antibiotics. Treatment requires individual assessment and regular monitoring.`,
      ],
    }),
    renderSection(`How ${name} Works`, {
      paragraphs: [
        'Isotretinoin reduces the size and activity of sebaceous glands, lowering the amount of skin oil produced. It also helps prevent blocked pores and reduces the inflammation and bacterial environment associated with severe acne. Improvement develops gradually during a prescribed treatment course.',
      ],
    }),
    renderSection('Common Side Effects', {
      items: [
        'Dry or cracked lips and dry skin',
        'Dry, irritated eyes',
        'Dry nose or occasional nosebleeds',
        'Increased sensitivity to sunlight',
        'Headache',
        'Muscle or joint discomfort',
        'Changes in blood lipids or liver-enzyme test results',
      ],
    }),
    renderSection('Important Safety Information', {
      paragraphs: [
        'Isotretinoin can cause severe birth defects and must not be used during pregnancy. Patients who can become pregnant require the pregnancy-prevention measures and testing directed by their prescriber. Blood donation must be avoided during treatment and for the period advised after treatment.',
        'Medical monitoring may include liver-function and blood-lipid tests. Report significant mood changes, severe headache with visual symptoms, persistent abdominal symptoms, or other unusual reactions promptly. Use only on prescription and never share this medicine.',
      ],
    }),
  ].join('');
}

function sourceOnlyFallbackDescription(product, name) {
  const specs = { ...(product.specs || {}), ...(product.seo?.specs || {}) };
  const ingredient = activeIngredient(product);
  const usage = specValue(specs, 'Usages', 'Usage', 'Uses', 'Indication', 'Application');
  return [
    renderSection('Uses', {
      paragraphs: [
        usage
          ? `${name} is prescribed for ${usage.replace(/^to\s+/i, '').replace(/[.]$/, '')}. The exact suitability must be confirmed by a qualified healthcare professional.`
          : `${name} is a prescription product. Its intended use and suitability should be confirmed from the prescription and approved product information.`,
      ],
    }),
    renderSection(`How ${name} Works`, {
      paragraphs: [
        ingredient
          ? `${name} contains ${ingredient}. Its clinical action depends on this active ingredient; patients should ask the prescriber or pharmacist for an explanation specific to the diagnosed condition.`
          : 'The mechanism depends on the active ingredient in the supplied product. Refer to the approved product information or consult the prescriber for medicine-specific details.',
      ],
    }),
    renderSection('Common Side Effects', {
      items: [
        'Side effects vary according to the active ingredient',
        'Read the supplied patient information before use',
        'Report persistent or troublesome symptoms to the prescriber',
        'Seek urgent help for signs of a severe allergic reaction',
      ],
    }),
    renderSection('Important Safety Information', {
      paragraphs: [
        'Use only under the guidance of a qualified healthcare professional. Do not change the prescribed strength or schedule, share the medicine, or combine it with other medicines without checking for interactions.',
      ],
    }),
  ].join('');
}

/**
 * Accept substantive AI copy only when it meets the medical-content contract.
 * Tadalafil and isotretinoin have reviewed fallbacks so weak or invalid AI copy
 * can never regress to a generic repetition of specs and packaging fields.
 */
export function buildProductDescription(product, aiDescription = '', displayName = '') {
  const name = clean(displayName || product.seo?.name || product.name, 180) || 'This Medicine';
  const safeAi = sanitizeDescriptionHtml(aiDescription);
  if (safeAi && descriptionQualityIssues(product, safeAi, name).length === 0) {
    return limitDescriptionHtml(safeAi);
  }

  const ingredient = activeIngredient(product).toLowerCase();
  let fallback;
  if (/\btadalafil\b/.test(ingredient)) fallback = tadalafilDescription(name);
  else if (/\bisotretinoin\b/.test(ingredient)) fallback = isotretinoinDescription(name);
  else fallback = sourceOnlyFallbackDescription(product, name);
  return limitDescriptionHtml(fallback);
}

/** Normalize generated, legacy or manually edited copy before TinyMCE receives it. */
export function prepareDescriptionHtml(value) {
  return limitDescriptionHtml(value);
}
