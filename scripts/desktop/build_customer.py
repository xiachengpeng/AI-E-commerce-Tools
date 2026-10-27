"""Build a new clean customer candidate using explicit existing build tools.

No dependency install, no developer app/data copy, no automatic public release.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]


def stage_frontend(source: Path, target: Path, icons: Path):
    target.mkdir(parents=True,exist_ok=False)
    for folder in ('css','js','assets'):
        shutil.copytree(source/folder,target/folder)
    (target/'dist').mkdir()
    shutil.copy2(source/'dist/output.css',target/'dist/output.css')
    shutil.copytree(icons/'src',target/'assets/phosphor')
    shutil.copy2(icons/'LICENSE',target/'assets/phosphor/LICENSE')
    value=(source/'index.html').read_text().replace('https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2.1.1/src/','assets/phosphor/')
    (target/'index.html').write_text(value)


def build(args):
    sys.path.insert(0, str(args.build_tools))
    from verify_customer import audit_content, verify
    from verify_bundle import validate
    output=args.output.absolute()
    import re
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', args.version):
        raise ValueError('Invalid version')
    if output.exists(): raise ValueError('Output already exists; choose a new directory')
    if not args.node_modules.is_dir() or not args.build_tools.is_dir(): raise ValueError('Explicit build tools missing')
    output.mkdir(parents=True,mode=0o700)
    resources=output/'resources';resources.mkdir()
    stage_frontend(ROOT/'frontend',resources/'frontend',args.node_modules/'@phosphor-icons/web')
    issues=audit_content(resources/'frontend')
    if issues: raise ValueError('Frontend content audit failed: '+','.join(issues))
    env={**os.environ,'PYTHONPATH':str(args.build_tools)}
    # Runtime code only; personal .env, SQLite, static files and migration scripts
    # are never collected. PyInstaller strips module co_filename source paths.
    command=[sys.executable,'-m','PyInstaller','--noconfirm','--onedir','--name','ai-ecommerce-backend',
       '--distpath',str(output/'dist'),'--workpath',str(output/'work'),'--specpath',str(output),
       '--paths',str(ROOT/'backend'),'--paths',str(ROOT),'--paths',str(ROOT/'backend/modules/research')]
    for name in ('main','run','frontend_server','aiosqlite'):command+=['--hidden-import',name]
    for name in ('services','routes','models','rabbit_hole','uvicorn','sqlalchemy.dialects.sqlite'):command+=['--collect-submodules',name]
    command+=['--collect-all','playwright','--collect-data','certifi','--exclude-module','pytest','--exclude-module','tkinter',
       '--add-data',str(ROOT/'backend/modules/research/rabbit_hole/data')+':rabbit_hole/data',str(ROOT/'backend/desktop_entry.py')]
    with (output/'freeze-build.log').open('w') as log:
        subprocess.run(command,check=True,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
    shutil.copytree(output/'dist/ai-ecommerce-backend',resources/'backend',symlinks=True)
    import playwright
    inventory=json.loads((Path(playwright.__file__).parent/'driver/package/browsers.json').read_text())
    browsers=resources/'browsers';browsers.mkdir();entries={}
    suffixes={'chromium':'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
       'chromium-headless-shell':'chrome-headless-shell-mac-arm64/chrome-headless-shell','ffmpeg':'ffmpeg-mac'}
    for item in inventory['browsers']:
        name=item['name']
        if name not in suffixes: continue
        folder=name.replace('-','_')+'-'+item['revision']
        shutil.copytree(args.browsers/folder,browsers/folder,symlinks=True)
        entries[name]='browsers/'+folder+'/'+suffixes[name]
    (resources/'browser-inventory.json').write_text(json.dumps(entries))
    (resources/'release.json').write_text(json.dumps({'schema':1,'channel':'customer','version':args.version,'status':'test-candidate','automatic_updates':False}))
    issues=validate(resources)
    if issues: raise ValueError('Resource audit failed: '+','.join(issues))
    shell=output/'shell';shell.mkdir()
    for name in ('main.cjs','process-manager.cjs','distribution.cjs','startup.html'):
        shutil.copy2(ROOT/'desktop'/name,shell/name)
    (shell/'package.json').write_text(json.dumps({'name':'ai-ecommerce-customer','version':args.version,'private':True,'main':'main.cjs','distribution':'customer'}))
    config={'shell':str(shell),'resources':str(resources),'output':str(output/'package'),
       'node_modules':str(args.node_modules),'electron_zip_dir':str(args.electron_zip_dir),'version':args.version}
    config_path=output/'package-input.json';config_path.write_text(json.dumps(config))
    with (output/'package-build.log').open('w') as log:
        subprocess.run(['node',str(ROOT/'desktop/build/customer-package.cjs'),str(config_path)],check=True,stdout=log,stderr=subprocess.STDOUT)
    app=output/'package/AI E-commerce Tools Customer-darwin-arm64/AI E-commerce Tools Customer.app'
    audit=verify(app/'Contents/Resources')
    if audit: raise ValueError('Customer candidate audit failed: '+','.join(audit))
    report={'version':args.version,'architecture':'arm64','clean_audit_passed':True,'development_signature_verified':True,
       'official_release_ready':False,'missing_release_gates':['Developer ID signing','Apple notarization','second Mac acceptance'],
       'automatic_updates':False}
    (output/'candidate-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    volume=output/'volume';volume.mkdir()
    # Hard links avoid another 1GB temporary duplicate; never modify this copy.
    shutil.copytree(app,volume/app.name,copy_function=os.link,symlinks=True)
    (volume/'Applications').symlink_to('/Applications',target_is_directory=True)
    for name in ('客户版安装与更新指南.md', '客户纯净版验收记录.md'):
        shutil.copy2(ROOT/'docs/desktop-client'/name,volume/name)
    shutil.copy2(output/'candidate-report.json',volume/'candidate-report.json')
    dmg=output/f'AI-Ecommerce-Customer-{args.version}-arm64-test-candidate.dmg'
    subprocess.run(['hdiutil','create','-volname','AI E-commerce Tools Customer','-srcfolder',str(volume),'-format','UDZO','-o',str(dmg)],check=True,capture_output=True)
    (output/'SHA256SUMS.txt').write_text(hashlib.sha256(dmg.read_bytes()).hexdigest()+'  '+dmg.name+'\n')
    subprocess.run(['hdiutil','verify',str(dmg)],check=True,capture_output=True)
    print(json.dumps({'candidate':str(dmg),'report':str(output/'candidate-report.json'),'official_release_ready':False}))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--node-modules',type=Path,required=True)
    parser.add_argument('--build-tools',type=Path,required=True)
    parser.add_argument('--browsers',type=Path,required=True)
    parser.add_argument('--electron-zip-dir',type=Path,required=True)
    parser.add_argument('--version',default='0.2.0')
    build(parser.parse_args())
