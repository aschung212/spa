/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf-8')

/**
 * Regression tests for index.html meta tags.
 *
 * Backstory: The overnight builder hallucinated "liftracker.app" (a competitor's
 * domain) as the canonical/OG URL instead of using the actual Vercel deployment
 * URL. This reached production because no test, CI check, or code review layer
 * verified URLs against the known deployment domain. Every URL in index.html
 * that references our domain must point to the real deployment.
 */

const DEPLOYMENT_DOMAIN = 'spa-rho-sandy.vercel.app'

describe('index.html meta tag regression tests', () => {
  describe('canonical and OG URLs point to actual deployment', () => {
    it('canonical URL uses the real deployment domain', () => {
      const match = html.match(/<link rel="canonical" href="([^"]+)"/)
      expect(match).not.toBeNull()
      expect(match![1]).toContain(DEPLOYMENT_DOMAIN)
    })

    it('og:url uses the real deployment domain', () => {
      const match = html.match(/<meta property="og:url" content="([^"]+)"/)
      expect(match).not.toBeNull()
      expect(match![1]).toContain(DEPLOYMENT_DOMAIN)
    })

    it('og:image uses the real deployment domain', () => {
      const match = html.match(/<meta property="og:image" content="([^"]+)"/)
      expect(match).not.toBeNull()
      expect(match![1]).toContain(DEPLOYMENT_DOMAIN)
    })

    it('twitter:image uses the real deployment domain', () => {
      const match = html.match(/<meta name="twitter:image" content="([^"]+)"/)
      expect(match).not.toBeNull()
      expect(match![1]).toContain(DEPLOYMENT_DOMAIN)
    })
  })

  describe('social preview accessibility and locale metadata', () => {
    it('og:image has descriptive alt text for screen readers on social unfurls', () => {
      const match = html.match(/<meta property="og:image:alt" content="([^"]+)"/)
      expect(match).not.toBeNull()
      expect(match![1].trim().length).toBeGreaterThan(0)
    })

    it('twitter:image has descriptive alt text for screen readers on social unfurls', () => {
      const match = html.match(/<meta name="twitter:image:alt" content="([^"]+)"/)
      expect(match).not.toBeNull()
      expect(match![1].trim().length).toBeGreaterThan(0)
    })

    it('og:locale gives crawlers an explicit language signal', () => {
      const match = html.match(/<meta property="og:locale" content="([^"]+)"/)
      expect(match).not.toBeNull()
      expect(match![1]).toBe('en_US')
    })

    it('og:image:type declares the MIME type so scrapers fetch the card reliably', () => {
      const match = html.match(/<meta property="og:image:type" content="([^"]+)"/)
      expect(match).not.toBeNull()
      expect(match![1]).toBe('image/png')
    })

    it('og:image:type matches the .png extension of the og:image URL', () => {
      const image = html.match(/<meta property="og:image" content="([^"]+)"/)
      const type = html.match(/<meta property="og:image:type" content="([^"]+)"/)
      expect(image).not.toBeNull()
      expect(type).not.toBeNull()
      expect(image![1]).toMatch(/\.png$/)
      expect(type![1]).toBe('image/png')
    })

    it('application-name labels the app for Android/Windows installs', () => {
      const match = html.match(/<meta name="application-name" content="([^"]+)"/)
      expect(match).not.toBeNull()
      expect(match![1]).toBe('Lift')
    })
  })

  describe('robots directive for SERP presentation', () => {
    it('declares a robots meta so the homepage is indexable', () => {
      const match = html.match(/<meta name="robots" content="([^"]+)"/)
      expect(match).not.toBeNull()
      expect(match![1]).toContain('index')
      expect(match![1]).toContain('follow')
    })

    it('opts into large image previews so Google renders the og-image, not a thumbnail', () => {
      const match = html.match(/<meta name="robots" content="([^"]+)"/)
      expect(match).not.toBeNull()
      expect(match![1]).toContain('max-image-preview:large')
    })
  })

  describe('positioning copy (LIFT-1028)', () => {
    it('the meta description states the unlimited / no-paywall differentiator', () => {
      const match = html.match(/<meta name="description" content="([^"]+)"/)
      expect(match).not.toBeNull()
      const desc = match![1].toLowerCase()
      expect(desc).toContain('unlimited')
      expect(desc).toContain('no paywall')
    })

    it('the og:description carries the free / no-paywall positioning', () => {
      const match = html.match(/<meta property="og:description" content="([^"]+)"/)
      expect(match).not.toBeNull()
      expect(match![1].toLowerCase()).toContain('no paywall')
    })
  })

  describe('viewport permits pinch-zoom (WCAG 1.4.4 / 1.4.10 — LIFT-1376)', () => {
    // The tag shipped as `... maximum-scale=1.0, user-scalable=no ...`, which
    // disables pinch-zoom outright: a WCAG 2.1 AA failure on both Resize Text
    // and Reflow, and a scored Lighthouse a11y audit. Nothing caught it because
    // this file only ever pinned URLs and the `--font-*` scale was rem-anchored
    // for exactly this reason (LIFT-988) — the CSS claimed a compliance the
    // meta tag revoked one file away.
    //
    // The zoom lock was ALSO suppressing iOS Safari's zoom-on-focus, so lifting
    // it is only safe while every focusable text control computes to >= 16px.
    // That half is enforced in cssRegression.test.ts ("iOS focus-zoom floor").
    // If an input starts zooming the page on focus, raise its font-size — do
    // not re-add the lock here.
    const viewport = html.match(/<meta name="viewport" content="([^"]+)"/)

    it('declares a viewport meta at all', () => {
      expect(viewport).not.toBeNull()
    })

    it('does not disable user scaling', () => {
      expect(viewport![1]).not.toMatch(/user-scalable\s*=\s*(no|0)/i)
    })

    it('does not cap the zoom factor below 5x', () => {
      // Lighthouse and WCAG both accept a maximum-scale of >= 5; anything
      // lower (and 1.0 in particular) is treated as a zoom block.
      const max = viewport![1].match(/maximum-scale\s*=\s*([\d.]+)/i)
      if (max) expect(Number(max[1])).toBeGreaterThanOrEqual(5)
    })

    it('still sizes to the device and covers the safe area', () => {
      // viewport-fit=cover is what makes env(safe-area-inset-*) resolve to real
      // values on notched devices — every fixed/sticky surface depends on it.
      expect(viewport![1]).toContain('width=device-width')
      expect(viewport![1]).toContain('viewport-fit=cover')
    })
  })

  describe('no references to domains we do not own', () => {
    it('does not reference liftracker.app (competitor domain)', () => {
      expect(html).not.toContain('liftracker.app')
    })

    it('all absolute URLs in meta tags use HTTPS', () => {
      const urls = html.match(/(?:href|content|src)="(http:\/\/[^"]+)"/g)
      expect(urls).toBeNull()
    })
  })
})
