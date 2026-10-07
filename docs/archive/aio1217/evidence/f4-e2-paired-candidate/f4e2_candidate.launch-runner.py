import os,sys,subprocess,socket,json,hashlib
from pathlib import Path
h=Path(__file__).resolve().parent
w=h.parent/'aio1217-worktree'
def production_fingerprint():
 paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard'],cwd=w,text=True).splitlines()
 selected=[x for x in paths if x.startswith(('app/','lib/','components/','public/','styles/','postgres/','config/','scripts/')) or '/' not in x and not x.startswith('vitest.') and x.endswith(('.ts','.js','.mjs','.json','.yaml','.yml'))]
 selected=list(set(selected)|{str(x.relative_to(w)) for x in w.glob('app/auth/dev-login/route.ts')})
 digest=hashlib.sha256()
 for x in sorted(selected):
  f=w/x
  if f.is_file():digest.update(x.encode()+b'\0'+f.read_bytes()+b'\0')
 return digest.hexdigest()
stage,tier=sys.argv[1:3]
assert stage.replace('-','').replace('_','').isalnum()
assert tier in ('unit','pg','http','gatewayhttp','queryhttp','devhttp','build','devbuild','typecheck','lint','docs')
for candidate in ('.env','.env.local','.env.development','.env.development.local','.env.production','.env.production.local','.env.test','.env.test.local'):
 assert not (w/candidate).exists(), 'Next env-file safety preflight refused: '+candidate
source_fp=production_fingerprint()
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip()
if tier in ('http','gatewayhttp','queryhttp','devhttp'):
 manifest=json.loads((h/'build-source-manifest.json').read_text())
 assert manifest['productionFingerprint']==source_fp,'Production build provenance mismatch; rebuild before HTTP'
 assert manifest['buildId']==(w/'.next/BUILD_ID').read_text().strip(),'BUILD_ID mismatch'
 (h/(stage+'.build-provenance.json')).write_text(json.dumps({'head':head,'productionFingerprint':source_fp,'buildId':manifest['buildId'],'buildRecord':manifest,'effectivePollers':{'INGEST_POLL_ENABLED':'false','GRAPH_PROJECT_ENABLED':'false','GRAPHITI_URL':'absent','SOCIAL_JOBS_ENABLED':'false'}},indent=2))
record_dir=os.environ.get('AIO1217_E4_RECORD_DIR')
if record_dir is not None:
 assert record_dir=='.context/aio1217-e4-observation-records', 'E4 recorder path must be the sole approved relative synthetic directory'
 assert not Path(record_dir).is_absolute() and '..' not in Path(record_dir).parts, 'E4 recorder path must remain relative and confined'
env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','TMPDIR','LANG','LC_ALL','SHELL','AIO1217_E4_RECORD_DIR')}
for key in ('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','OPENAI_API_KEY','LLM_API_KEY','LLM_BASE_URL','GRAPHITI_URL','NEO4J_URL','SENTRY_DSN','NEXT_PUBLIC_SENTRY_DSN','SENTRY_AUTH_TOKEN','SMTP_HOST','SMTP_URL','SMTP_USER','SMTP_PASSWORD','RESEND_API_KEY'):
 env[key]=''
env.update(NEXT_TELEMETRY_DISABLED='1',INGEST_POLL_ENABLED='false',GRAPH_PROJECT_ENABLED='false',SOCIAL_AUTORUN='false',SOCIAL_JOBS_ENABLED='false',AUTH_SECRET='http-tier-test-secret-not-for-production',SECRETS_KEY='BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',APP_URL='http://127.0.0.1:1')
if tier=='unit' and sys.argv[3:] in ([], ['--coverage'], ['--coverage', '--maxWorkers=2']):
 env.pop('SECRETS_KEY',None)  # Full unit suite tests the missing-key default; DB/HTTP/build keep synthetic key.
if tier in ('pg','http','gatewayhttp','queryhttp','devhttp','devbuild'):
 identity=subprocess.check_output(['docker','inspect','--format','{{.Name}} {{.Config.Image}}','aios-aio1217-pg-8a4e78cb'],text=True).strip()
 assert identity.startswith('/aios-aio1217-pg-8a4e78cb ') and 'postgres' in identity
 mapping=subprocess.check_output(['docker','port','aios-aio1217-pg-8a4e78cb','5432/tcp'],text=True).strip().splitlines()
 assert mapping and all(line.rsplit(':',1)[1]==mapping[0].rsplit(':',1)[1] for line in mapping), 'Dedicated database mapping mismatch'
 pgport=int(mapping[0].rsplit(':',1)[1]);url=f'postgres://app:app@127.0.0.1:{pgport}/app_test'
 env.update(DATABASE_TEST_URL=url,DATABASE_URL=url,DB_BACKEND='postgres',NEXT_PUBLIC_DB_BACKEND='postgres',LLM_BASE_URL='')
 if tier in ('http','gatewayhttp','queryhttp'):
  with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
  env.update(HTTP_TEST_PORT=str(port),APP_URL=f'http://127.0.0.1:{port}')
 else:port=None
 (h/(stage+'.environment.json')).write_text(json.dumps({'container':identity,'database':'synthetic app_test loopback','postgresPort':pgport,'httpPort':port,'providerEnv':'allowlisted without credentials','functionalOnly':True},indent=2))
if tier=='gatewayhttp':env['AIOS_GATEWAY_INTERNAL_ENABLED']='true'
commands={'gatewayhttp':['npm','run','test:http:gateway-approval'],'queryhttp':['npx','vitest','run','--config','vitest.tierret1-query.config.ts'],'unit':['npx','vitest','run'],'pg':['npx','vitest','run','--config','vitest.datamechanics.config.ts'],'http':['npm','run','test:http'],'devhttp':['npx','vitest','run','--config','vitest.dev-login.config.ts'],'build':['npm','run','build'],'devbuild':['npm','run','test:http:dev-login:build'],'typecheck':['npm','run','typecheck'],'lint':['npx','eslint'],'docs':['npm','run','check:docs']}
cmd=commands[tier]+(['--'] if tier in ('http','gatewayhttp') and sys.argv[3:] else [])+sys.argv[3:]
(h/(stage+'.launch-runner.py')).write_bytes(Path(__file__).read_bytes())
def test_fingerprint():
 test_paths=set(subprocess.check_output(['git','ls-files','test'],cwd=w,text=True).splitlines())
 test_paths.update(str(p.relative_to(w)) for p in w.glob('vitest.*') if p.is_file())
 test_paths.update(str(p.relative_to(w)) for p in (w/'test').rglob('*') if p.is_file() and p.suffix in ('.ts','.tsx'))
 test_digest=hashlib.sha256()
 for path in sorted(test_paths):
  f=w/path
  if f.is_file():test_digest.update(path.encode()+b'\0'+f.read_bytes()+b'\0')
 return test_digest.hexdigest()
test_fp=test_fingerprint()
(h/(stage+'.provenance.json')).write_text(json.dumps({'head':head,'productionFingerprint':source_fp,'testFingerprint':test_fp,'command':cmd,'providerEnvironment':'allowlisted synthetic no credentials','runnerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},indent=2))
print(stage+': '+str(cmd),flush=True)
with (h/(stage+'.log')).open('w') as log:
 result=subprocess.run(cmd,cwd=w,env=env,stdout=log,stderr=subprocess.STDOUT)
after_fp=production_fingerprint()
after_test_fp=test_fingerprint()
if tier not in ('build','devbuild') and after_test_fp!=test_fp:
 print('Test source changed during check; refusing snapshot acceptance',flush=True)
 result.returncode=3
if tier in ('http','gatewayhttp','queryhttp','devhttp','build','devbuild') and after_fp!=source_fp:
 print('Source changed during '+tier+'; refusing provenance acceptance',flush=True)
 result.returncode=3
(h/(stage+'.result.json')).write_text(json.dumps({'exit':result.returncode,'tier':tier,'command':cmd,'productionBefore':source_fp,'productionAfter':after_fp,'unchanged':after_fp==source_fp,'testBefore':test_fp,'testAfter':after_test_fp,'testUnchanged':test_fp==after_test_fp},indent=2))
if tier in ('build','devbuild') and result.returncode==0:
 assert production_fingerprint()==source_fp,'Source changed during build'
 (h/'build-source-manifest.json').write_text(json.dumps({'head':head,'productionFingerprint':source_fp,'buildId':(w/'.next/BUILD_ID').read_text().strip(),'actualCommand':cmd,'log':stage+'.log','exit':0,'reconstructedBaseline':False},indent=2))
print(stage+': exit='+str(result.returncode),flush=True)
sys.exit(result.returncode)
