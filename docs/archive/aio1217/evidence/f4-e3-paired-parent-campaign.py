from pathlib import Path
import subprocess,json,hashlib,shutil,datetime
h=Path('/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff');w=h.parent/'aio1217-worktree'
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
r=json.loads((h/'f4-e3-paired-pg-parent-execution-request.json').read_text());helper=Path(r['helper']);runner=Path(r['runner'])
assert sha(helper)==r['helperSha256'];assert sha(runner)==r['runnerSha256'];assert sha(w/r['fixture'])==r['fixtureSha256']
checkpoint=subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip();assert checkpoint==r['checkpoint']
assert not subprocess.check_output(['git','status','--porcelain'],cwd=w,text=True).strip()
port=subprocess.check_output(['docker','port','aios-aio1217-pg-8a4e78cb','5432/tcp'],text=True).strip();assert port.splitlines()==['127.0.0.1:50538']
base=r['candidateRuntimeBase'];ref=r['referenceOwnerCommit'];fixture=r['fixture'];owners=r['referenceOwnerBlobPaths']
root=Path('/private/tmp/aio1217-paired-e3-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));root.mkdir()
result={'executedHelperSha256':sha(helper),'hostScriptSha256':sha(__file__),'utcStarted':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checkpoint':checkpoint,'candidateRuntimeBase':base,'referenceOwnerCommit':ref,'dedicatedPgPort':50538,'correctedRunnerSha256':sha(runner),'runs':[],'acceptanceGranted':False}
for role,exitclass in [('reference','nonzero'),('candidate','zero')]:
 layout=root/role;layout.mkdir();rw=layout/'aio1217-worktree';rh=layout/'aio1217-handoff';rh.mkdir()
 subprocess.run(['git','clone','--quiet','--no-hardlinks',str(w),str(rw)],check=True);subprocess.run(['git','checkout','--quiet','--detach',base],cwd=rw,check=True)
 (rw/'node_modules').symlink_to(w/'node_modules',target_is_directory=True);shutil.copyfile(w/fixture,rw/fixture)
 if role=='reference':
  for f in owners:(rw/f).write_bytes(subprocess.check_output(['git','show',ref+':'+f],cwd=w))
 assert sha(rw/fixture)==r['fixtureSha256']
 mapping=subprocess.check_output(['docker','port','aios-aio1217-pg-8a4e78cb','5432/tcp'],text=True).strip();assert mapping=='127.0.0.1:50538'
 run={'ownedPgMapping':mapping,'role':role,'actualGitHead':base,'compositeRuntime':True,'fixtureOverlaySha256':sha(rw/fixture),'owners':{f:sha(rw/f) for f in owners},'configSha256':sha(rw/'vitest.datamechanics.config.ts'),'packageLockSha256':sha(rw/'package-lock.json'),'dependencyTarget':str(w/'node_modules'),'utcStarted':datetime.datetime.now(datetime.timezone.utc).isoformat(),'substitutions':owners if role=='reference' else [],'expectedExitClass':exitclass}
 stage='f4e3_'+role;cmd=['zsh',str(helper),role,exitclass,str(rw),str(rh),stage];run['command']=cmd
 with (rh/'parent-command.log').open('w') as log:p=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
 run.update(helperExit=p.returncode,utcFinished=datetime.datetime.now(datetime.timezone.utc).isoformat());out=h/('f4-e3-paired-'+role);out.mkdir(exist_ok=False)
 for f in rh.iterdir():
  if f.is_file():shutil.copyfile(f,out/f.name)
 records=rw/'.context/aio1217-e4-observation-records/requests.jsonl'
 if records.exists():shutil.copyfile(records,out/'requests.jsonl');run['recordCount']=len(records.read_text().splitlines())
 for owner in owners:(out/('owner-'+str(owners.index(owner))+'.ts')).write_bytes((rw/owner).read_bytes())
 paths=subprocess.check_output(['git','ls-files'],cwd=rw,text=True).splitlines();run['loadedTreeFileHashes']={f:sha(rw/f) for f in paths if (rw/f).is_file()};run['artifactHashes']={f.name:sha(f) for f in out.iterdir() if f.is_file()};run['evidencePath']=str(out)
 (out/'composite-runtime.json').write_text(json.dumps(run,indent=2));result['runs'].append(run);(h/'f4-e3-paired-parent.result.json').write_text(json.dumps(result,indent=2));print(json.dumps({'role':role,'helperExit':p.returncode,'records':run.get('recordCount'),'evidencePath':str(out)}),flush=True)
 if p.returncode:break
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip()==checkpoint;assert not subprocess.check_output(['git','status','--porcelain'],cwd=w,text=True).strip()
if len(result['runs'])==2:
 differences=[f for f,d in result['runs'][0]['loadedTreeFileHashes'].items() if result['runs'][1]['loadedTreeFileHashes'].get(f)!=d];assert sorted(differences)==sorted(owners);result['actualReferenceCandidateFileDifferences']=differences
result.update(utcFinished=datetime.datetime.now(datetime.timezone.utc).isoformat(),originalWorktreeUnchanged=True);(h/'f4-e3-paired-parent.result.json').write_text(json.dumps(result,indent=2))
subprocess.run(['python3',str(h/'run_check.py'),'f4e3_unknown_slug_lint','lint',fixture],check=True)
subprocess.run(['python3',str(h/'run_check.py'),'f4e3_unknown_slug_typecheck','typecheck'],check=True)
