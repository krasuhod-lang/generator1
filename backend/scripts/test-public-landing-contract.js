const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const router = read('frontend/src/router/index.js');
const landing = read('frontend/src/views/PublicLandingPage.vue');
const index = read('frontend/index.html');
const wpFront = read('wordpress/seo-genius-homepage/front-page.php');
const wpFunctions = read('wordpress/seo-genius-homepage/functions.php');
const wpCss = read('wordpress/seo-genius-homepage/assets/seo-genius-landing.css');

function check(name, predicate) {
  assert(predicate, name);
  console.log(`✓ ${name}`);
}

check('root route is public landing, not dashboard redirect', router.includes("{ path: '/',") && router.includes("PublicLandingPage.vue") && !router.includes("path: '/',         redirect: '/dashboard'"));
check('authenticated dashboard route remains protected', /path:\s*['"]\/dashboard['"][\s\S]*meta:\s*\{\s*auth:\s*true\s*\}/.test(router));
check('landing has conversion CTA and pricing anchors', landing.includes('to="/register"') && landing.includes('id="plans"') && landing.includes('id="faq"'));
check('landing includes structured product sections and FAQ', landing.includes('id="platform"') && landing.includes('id="workflow"') && landing.includes('application/ld+json'));
check('landing metadata has Russian description and robots policy', index.includes('name="description"') && index.includes('name="robots" content="index,follow'));
check('WordPress theme has front template, enqueue and schema hooks', wpFront.includes('wp_head();') && wpFront.includes('wp_footer();') && wpFunctions.includes("add_action('wp_enqueue_scripts'"));
check('WordPress theme uses configurable app auth URLs', wpFront.includes('SEO_GENIUS_LOGIN_URL') && wpFront.includes('SEO_GENIUS_REGISTER_URL'));
check('WordPress CSS has responsive and focus-visible rules', wpCss.includes('@media (max-width: 720px)') && wpCss.includes('focus-visible'));
check('landing package contains no secret-like assignments', !/(API_KEY|SECRET|PASSWORD|TOKEN)\s*=|sk-[A-Za-z0-9]/.test(`${wpFront}\n${wpFunctions}`));
console.log('public-landing-contract: 9/9 passed');
