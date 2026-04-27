#!/usr/bin/env python3
"""
ExternalLink - Backlink Batch Submission System
Uses DeepSeek V4 Pro AI to drive browser automation

Usage:
  python main.py run --site site-a              # Run single site
  python main.py run --site all                 # Run all sites in parallel
  python main.py add-candidates --file INPUT --site site-a  # Import candidates
  python main.py stats --site site-a            # View statistics
  python main.py export --site site-a           # Export submitted backlinks
  python main.py init                           # Initialize database
"""

import asyncio
import argparse
import json
import sys
import os
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from src.db import init_db, get_stats, get_submitted_count, get_candidates, add_candidate
from src.browser import BrowserController
from src.submitter import LinkSubmitter, SkillKnowledge


def cmd_init(args):
    """Initialize database"""
    print("Initializing LinkForge DB...")
    init_db()
    print("[OK] Database initialized!")
    print(f"   DB path: {Path('db/linkforge.db').resolve()}")
    knowledge = SkillKnowledge.load_all()
    print(f"   Skill files: {len(knowledge)} loaded")


def cmd_stats(args):
    """View statistics"""
    init_db()
    site_id = args.site if args.site != 'all' else None
    stats = get_stats(site_id)

    print(f"\n{'='*50}")
    print("ExternalLink Statistics")
    print(f"{'='*50}")
    print(f"Total Submitted: {stats.get('total', 0) or 0}")
    print(f"Dofollow:         {stats.get('dofollow', 0) or 0}")
    print(f"Nofollow:         {stats.get('nofollow', 0) or 0}")
    print(f"Unique Domains:   {stats.get('unique_domains', 0) or 0}")

    dof = (stats.get('dofollow', 0) or 0)
    total = (stats.get('total', 0) or 1)
    print(f"Dofollow Rate:    {dof / total * 100:.1f}%")
    print(f"{'='*50}")

    print("\nBy Platform Type:")
    for p in stats.get('by_platform', []):
        print(f"  {p['platform_type']:20s}: {p['cnt']}")


def cmd_add_candidates(args):
    """Import candidates from file"""
    init_db()

    if not args.file:
        print("[ERROR] Please specify input file: --file candidates.txt")
        return

    filepath = Path(args.file)
    if not filepath.exists():
        print(f"[ERROR] File not found: {filepath}")
        return

    content = filepath.read_text(encoding='utf-8')
    added = 0
    skipped = 0

    for line in content.strip().split('\n'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue

        parts = line.split('|')
        domain = parts[0].strip()
        traffic = int(parts[1]) if len(parts) > 1 and parts[1].strip().isdigit() else 0
        dr = float(parts[2]) if len(parts) > 2 else 0
        platform_type = parts[3].strip() if len(parts) > 3 else 'unknown'

        result = add_candidate(
            domain=domain,
            traffic=traffic,
            dr=dr,
            platform_type=platform_type,
            url=f"https://{domain}" if not domain.startswith('http') else domain
        )

        if result:
            added += 1
            print(f"  [OK] {domain} (traffic={traffic}, DR={dr}, type={platform_type})")
        else:
            skipped += 1

    print(f"\nImport complete: {added} new, {skipped} duplicates skipped")


def cmd_export(args):
    """Export submitted backlinks"""
    init_db()
    import csv
    from datetime import datetime

    site_id = args.site if args.site != 'all' else None

    output_file = args.output or f"export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    if site_id:
        output_file = output_file.replace('.csv', f'_{site_id}.csv')

    from src.db import get_connection
    conn = get_connection()
    cursor = conn.cursor()

    if site_id:
        cursor.execute("""
            SELECT site_id, domain, url, platform_type, anchor_text, rel, traffic, status, submitted_at
            FROM submitted_links WHERE site_id = ?
            ORDER BY submitted_at DESC
        """, (site_id,))
    else:
        cursor.execute("""
            SELECT site_id, domain, url, platform_type, anchor_text, rel, traffic, status, submitted_at
            FROM submitted_links
            ORDER BY submitted_at DESC
        """)

    rows = cursor.fetchall()
    conn.close()

    with open(output_file, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['site_id', 'domain', 'url', 'platform_type', 'anchor_text', 'rel', 'traffic', 'status', 'submitted_at'])
        for row in rows:
            writer.writerow(row)

    print(f"[OK] Exported {len(rows)} records -> {output_file}")


def cmd_list_candidates(args):
    """List candidates"""
    init_db()
    site_id = args.site if args.site != 'all' else 'default'
    candidates = get_candidates(site_id, limit=args.limit or 50)

    print(f"\n{'='*60}")
    print(f"{'Domain':35s} {'Traffic':>8s} {'DR':>6s} {'Type':>15s}")
    print('-' * 60)
    for c in candidates:
        print(f"{c['domain']:35s} {c['traffic']:>8d} {c['dr']:>6.1f} {c['platform_type']:>15s}")
    print(f"{'='*60}")
    print(f"Total: {len(candidates)} candidates")


async def cmd_interactive(args):
    """Run interactive semi-auto submission (visible browser, pause on captcha)"""
    from src.interactive import InteractiveSubmitter

    init_db()

    config_path = Path(f"config/{args.site}.json")
    if not config_path.exists():
        print(f"[ERROR] Config not found: {config_path}")
        return

    config = json.loads(config_path.read_text(encoding='utf-8'))

    # Force visible browser
    if 'browser' not in config:
        config['browser'] = {}
    config['browser']['headless'] = False

    print(f"\n[INTERACTIVE] Starting visible browser for {args.site}...")
    print(f"[INTERACTIVE] Site: {config.get('brand_name', config.get('domain', 'unknown'))}")
    print(f"[INTERACTIVE] Domain: {config.get('domain', 'unknown')}")

    browser = BrowserController(str(config_path))
    await browser.start()

    try:
        submitter = InteractiveSubmitter(browser, config)
        result = await submitter.run()
        print(json.dumps(result, indent=2))
    finally:
        await browser.save_storage_state()
        print("\n[OK] Browser storage saved")
        await browser.close()
        print("[OK] Browser closed")


async def cmd_run(args):
    """Run backlink submission task"""
    init_db()

    if args.site == 'all':
        config_dir = Path("config")
        site_configs = sorted(config_dir.glob("site-*.json"))

        if not site_configs:
            print("[ERROR] No site config files found (config/site-*.json)")
            return

        print(f"[START] Launching {len(site_configs)} site(s) in parallel...")
        tasks = []
        for cfg in site_configs:
            tasks.append(_run_single_site(str(cfg)))

        results = await asyncio.gather(*tasks, return_exceptions=True)
        for cfg, result in zip(site_configs, results):
            if isinstance(result, Exception):
                print(f"  [{cfg.stem}] ERROR: {result}")
            else:
                print(f"  [{cfg.stem}] Done: {result}")
    else:
        config_path = Path(f"config/{args.site}.json")
        if not config_path.exists():
            print(f"[ERROR] Config file not found: {config_path}")
            print("  Please create site config in config/ directory first")
            return

        print(f"[START] Running single site: {args.site}")
        result = await _run_single_site(str(config_path))
        print(f"Result: {result}")


async def _run_single_site(config_path: str):
    """Run a single site"""
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)

    browser = BrowserController(config_path)
    await browser.start()

    try:
        submitter = LinkSubmitter(browser, config, mode='auto')
        results = await submitter.run()
    finally:
        await browser.save_storage_state()
        await browser.close()

    return results


def cmd_rel_check(args):
    """Check rel attribute on a specific page"""
    config_path = Path(f"config/{args.site}.json")
    if not config_path.exists():
        print(f"[ERROR] Config not found: {config_path}")
        return

    async def check():
        browser = BrowserController(str(config_path))
        await browser.start()
        try:
            await browser.navigate(args.url)
            await asyncio.sleep(2)
            results = await browser.check_rel(args.domain or browser.domain)
            print(f"\nCheck results:")
            for r in results:
                status = '[DOFOLLOW]' if r['rel'] == 'EMPTY' else f'[{r["rel"]}]'
                print(f"  {status} | {r['href'][:100]}")
        finally:
            await browser.close()

    asyncio.run(check())


def main():
    parser = argparse.ArgumentParser(
        description='ExternalLink - Backlink Batch Submission System',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py init
  python main.py add-candidates --file candidates.txt
  python main.py list --site site-a
  python main.py run --site site-a
  python main.py run --site all
  python main.py stats --site site-a
  python main.py export --site site-a
  python main.py rel-check --site site-a --url https://example.com --domain mysite.com
        """
    )

    subparsers = parser.add_subparsers(dest='command', help='Available commands')

    # init
    subparsers.add_parser('init', help='Initialize database')

    # stats
    stats_parser = subparsers.add_parser('stats', help='View statistics')
    stats_parser.add_argument('--site', default='all', help='Site ID (default: all)')

    # add-candidates
    add_parser = subparsers.add_parser('add-candidates', help='Import candidates')
    add_parser.add_argument('--file', required=True, help='Candidates file (domain|traffic|dr|platform_type)')
    add_parser.add_argument('--site', default='site-a', help='Site ID')

    # list
    list_parser = subparsers.add_parser('list', help='List candidates')
    list_parser.add_argument('--site', default='site-a', help='Site ID')
    list_parser.add_argument('--limit', type=int, default=50)

    # interactive
    int_parser = subparsers.add_parser('interactive', help='Interactive semi-auto mode (visible browser, pause on captcha)')
    int_parser.add_argument('--site', required=True, help='Site ID (e.g. site-a)')

    # run
    run_parser = subparsers.add_parser('run', help='Run backlink submission')
    run_parser.add_argument('--site', required=True, help='Site ID or "all"')
    run_parser.add_argument('--headless', action='store_true', help='Headless mode')

    # export
    export_parser = subparsers.add_parser('export', help='Export submitted backlinks')
    export_parser.add_argument('--site', default='all', help='Site ID')
    export_parser.add_argument('--output', help='Output file path')

    # rel-check
    rel_parser = subparsers.add_parser('rel-check', help='Check page rel attribute')
    rel_parser.add_argument('--site', required=True, help='Site config')
    rel_parser.add_argument('--url', required=True, help='Target page URL')
    rel_parser.add_argument('--domain', required=True, help='Domain to check')

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    commands = {
        'init': cmd_init,
        'stats': cmd_stats,
        'add-candidates': cmd_add_candidates,
        'list': cmd_list_candidates,
        'interactive': lambda a: asyncio.run(cmd_interactive(a)),
        'run': lambda a: asyncio.run(cmd_run(a)),
        'export': cmd_export,
        'rel-check': cmd_rel_check,
    }

    handler = commands.get(args.command)
    if handler:
        handler(args)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()