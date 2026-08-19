import re

with open('backend/src/services/parser/scraper.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix NOISE_SELECTORS
content = content.replace(
    '\'[class*="banner" i]\', \'[class*="popup" i]\', \'[class*="modal" i]\',',
    '\'[class~="banner" i]\', \'[class*="cookie-banner" i]\', \'[class*="promo-banner" i]\', \'[class~="popup" i]\', \'[class*="cookie-popup" i]\', \'[class~="modal" i]\','
)

# Fix fallback branch cheerio
content = content.replace(
    '\'[class*="popup" i], [class*="banner" i], \' +',
    '\'[class~="popup" i], [class*="cookie-popup" i], [class~="banner" i], [class*="cookie-banner" i], [class*="promo-banner" i], \' +'
)

# Fix fallback branch text extraction
old_text_ext = """  const title    = $('title').text().trim() || $('h1').first().text().trim();
  let   bodyText = $('body').text().replace(/\s{2,}/g, ' ').trim();
  bodyText = _stripFooterArtifacts(bodyText);"""

new_text_ext = """  const title    = $('title').text().trim() || $('h1').first().text().trim();
  const turndown = new TurndownService({
    headingStyle:     'atx',
    bulletListMarker: '-',
    codeBlockStyle:   'fenced',
  });
  let bodyText = turndown.turndown($('body').html() || '');
  bodyText = _stripFooterArtifacts(bodyText);"""

content = content.replace(old_text_ext, new_text_ext)

with open('backend/src/services/parser/scraper.js', 'w', encoding='utf-8') as f:
    f.write(content)
