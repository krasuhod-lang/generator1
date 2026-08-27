<?php
/**
 * SEO Genius Homepage theme bootstrap.
 *
 * The public homepage is intentionally isolated from the authenticated SPA.
 */
if (!defined('ABSPATH')) {
    exit;
}

function seo_genius_homepage_setup() {
    add_theme_support('title-tag');
    add_theme_support('post-thumbnails');
    add_theme_support('html5', array('search-form', 'comment-form', 'comment-list', 'gallery', 'caption', 'style', 'script'));
    register_nav_menus(array(
        'primary' => __('Primary navigation', 'seo-genius-homepage'),
    ));
}
add_action('after_setup_theme', 'seo_genius_homepage_setup');

function seo_genius_homepage_assets() {
    wp_enqueue_style(
        'seo-genius-homepage',
        get_stylesheet_directory_uri() . '/assets/seo-genius-landing.css',
        array(),
        '1.0.0'
    );
}
add_action('wp_enqueue_scripts', 'seo_genius_homepage_assets');

function seo_genius_homepage_meta() {
    if (!is_front_page()) {
        return;
    }
    echo '<meta name="description" content="SEO Genius — AI-платформа для исследования спроса, генерации экспертного SEO-контента и роста органического трафика в Google и Яндексе." />' . "\n";
    echo '<meta name="robots" content="index,follow,max-image-preview:large" />' . "\n";
    echo '<meta property="og:type" content="website" />' . "\n";
    echo '<meta property="og:title" content="SEO Genius — AI-платформа для роста трафика" />' . "\n";
    echo '<meta property="og:description" content="От исследования спроса до экспертного SEO-контента и понятных отчётов — в одном pipeline." />' . "\n";
    echo '<meta property="og:url" content="' . esc_url(home_url('/')) . '" />' . "\n";
    echo '<meta name="twitter:card" content="summary_large_image" />' . "\n";
}
add_action('wp_head', 'seo_genius_homepage_meta', 2);

function seo_genius_homepage_schema() {
    if (!is_front_page()) {
        return;
    }
    $schema = array(
        '@context' => 'https://schema.org',
        '@type' => 'SoftwareApplication',
        'name' => 'SEO Genius',
        'applicationCategory' => 'BusinessApplication',
        'operatingSystem' => 'Web',
        'description' => 'AI-платформа для исследования спроса, генерации экспертного SEO-контента и роста органического трафика.',
        'url' => home_url('/'),
        'offers' => array(
            '@type' => 'Offer',
            'category' => 'AI SEO platform',
            'availability' => 'https://schema.org/OnlineOnly',
        ),
    );
    echo '<script type="application/ld+json">' . wp_json_encode($schema, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . '</script>' . "\n";
}
add_action('wp_head', 'seo_genius_homepage_schema', 3);
