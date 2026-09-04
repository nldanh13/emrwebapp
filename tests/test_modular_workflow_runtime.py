import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_node(source: str, *, env=None):
    merged = os.environ.copy()
    merged.update(env or {})
    proc = subprocess.run(["node", "-e", source], cwd=ROOT, env=merged, capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stderr or proc.stdout
    return proc.stdout.strip()


def test_feature_gate_only_blocks_disabled_module(tmp_path):
    runtime = tmp_path / "runtime"
    override = runtime / "config" / "feature_overrides.json"
    override.parent.mkdir(parents=True)
    override.write_text(json.dumps({"version": 1, "features": {"care.input": {"enabled": False}}}), encoding="utf-8")
    gate = json.dumps(str(ROOT / "server" / "middleware" / "feature_gate.js"))
    source = f"""
      const {{featureGate}}=require({gate});
      function call(method,path) {{
        return new Promise(resolve=>{{
          const req={{method,path}};
          const res={{code:200,status(n){{this.code=n;return this;}},json(v){{resolve({{next:false,code:this.code,payload:v}});}}}};
          featureGate(req,res,()=>resolve({{next:true,code:200}}));
        }});
      }}
      Promise.all([call('POST','/run-input-care'),call('POST','/run-input-infusions')]).then(v=>console.log(JSON.stringify(v)));
    """
    payload = json.loads(run_node(source, env={"EMR_RUNTIME_ROOT": str(runtime)}))
    assert payload[0]["code"] == 409
    assert payload[0]["payload"]["feature_id"] == "care.input"
    assert payload[1]["next"] is True


def test_protected_precheck_cannot_be_disabled(tmp_path):
    service = json.dumps(str(ROOT / "server" / "services" / "feature_registry.js"))
    source = f"""
      const r=require({service});
      try {{ r.updateFeatureOverride('input.precheck',{{enabled:false}}); process.exit(2); }}
      catch(err) {{ console.log(JSON.stringify({{code:err.code,status:err.status}})); }}
    """
    payload = json.loads(run_node(source, env={"EMR_RUNTIME_ROOT": str(tmp_path / "runtime")}))
    assert payload == {"code": "PROTECTED_FEATURE", "status": 409}


def test_workflow_plan_keeps_input_branches_independent(tmp_path):
    planner = json.dumps(str(ROOT / "server" / "services" / "workflow_planner.js"))
    session = json.dumps(str(ROOT / "server" / "services" / "session.js"))
    source = f"""
      const p=require({planner}); const s=require({session});
      const ctx=s.buildRuntimePathsForSid('default');
      const plan=p.planWorkflow(ctx,'ward-input',{{
        available_artifacts:['patients.raw','date.range','orders.raw','orders.classified','patients.room-scope','input.plan','nurse.schedule'],
        inputs:{{careTargets:{{patientIds:['P1'],patientDates:{{P1:['01/08/2026']}}}}}}
      }});
      console.log(JSON.stringify(plan));
    """
    plan = json.loads(run_node(source, env={"EMR_RUNTIME_ROOT": str(tmp_path / "runtime")}))
    by_id = {step["id"]: step for step in plan["steps"]}
    assert by_id["care.precheck"]["status"] == "ready"
    assert by_id["care.input"]["status"] == "ready"
    assert by_id["infusion.precheck"]["status"] == "needs-input"
    assert by_id["procedure.precheck"]["status"] == "needs-input"


def test_report_route_validates_ott_before_handler():
    source = (ROOT / "server" / "routes" / "report.js").read_text(encoding="utf-8")
    assert "router.get('/run-report-infusion', requireOttOrAppToken" in source
    assert "if (req.auth && req.auth.auth_type !== 'one_time_token') return next();" in source


def test_workflow_runner_continues_independent_branch(tmp_path):
    runner = json.dumps(str(ROOT / "server" / "services" / "workflow_runner.js"))
    session = json.dumps(str(ROOT / "server" / "services" / "session.js"))
    source = f"""
      const {{runWorkflow}}=require({runner});
      const {{buildRuntimePathsForSid}}=require({session});
      const calls=[];
      global.fetch=async (_url, options={{}})=>{{
        const step=options.headers?.['x-workflow-step-id']; calls.push(step);
        if(step==='care.precheck') return new Response(JSON.stringify({{status:'error',message:'care failed'}}),{{status:500,headers:{{'content-type':'application/json'}}}});
        if(step==='infusion.precheck') return new Response(JSON.stringify({{status:'ok',precheck_token:'token-infusion',precheck_expires_at:'2099-01-01T00:00:00Z'}}),{{status:200,headers:{{'content-type':'application/json'}}}});
        if(step==='infusion.input') return new Response(JSON.stringify({{status:'ok',count:1,message:'infusion done'}}),{{status:200,headers:{{'content-type':'application/json'}}}});
        throw new Error('Unexpected step '+step);
      }};
      const req={{auth:{{id:'tester',name:'Tester',role:'admin'}},get(){{return '';}}}};
      const ctx=buildRuntimePathsForSid('default');
      runWorkflow(req,ctx,'ward-input',{{
        skip_steps:['orders.fetch','orders.classify','input.prepare','procedure.precheck','procedure.input'],
        available_artifacts:['input.plan','orders.classified','nurse.schedule'],
        inputs:{{careTargets:{{targets:[{{id:'P1'}}]}},infusionTargets:{{targets:[{{id:'P1'}}]}}}}
      }}).then(run=>console.log(JSON.stringify({{status:run.status,calls,steps:Object.fromEntries(run.steps.map(s=>[s.id,s.status]))}}))).catch(err=>{{console.error(err);process.exit(1);}});
    """
    payload = json.loads(run_node(source, env={"EMR_RUNTIME_ROOT": str(tmp_path / "runtime")}))
    assert payload["status"] == "partial"
    assert payload["steps"]["care.precheck"] == "failed"
    assert payload["steps"]["care.input"] == "skipped"
    assert payload["steps"]["infusion.precheck"] == "succeeded"
    assert payload["steps"]["infusion.input"] == "succeeded"
    assert payload["steps"]["input.verify"] == "succeeded"
    assert payload["calls"] == ["care.precheck", "infusion.precheck", "infusion.input"]


def test_planner_propagates_missing_input_without_false_ready(tmp_path):
    planner = json.dumps(str(ROOT / "server" / "services" / "workflow_planner.js"))
    session = json.dumps(str(ROOT / "server" / "services" / "session.js"))
    source = f"""
      const p=require({planner}); const s=require({session});
      const plan=p.planWorkflow(s.buildRuntimePathsForSid('default'),'ward-input',{{
        skip_steps:['orders.fetch','orders.classify','input.prepare'],
        available_artifacts:['input.plan','orders.classified','nurse.schedule']
      }});
      console.log(JSON.stringify(plan));
    """
    plan = json.loads(run_node(source, env={"EMR_RUNTIME_ROOT": str(tmp_path / "runtime")}))
    by_id = {step["id"]: step for step in plan["steps"]}
    assert by_id["care.precheck"]["status"] == "needs-input"
    assert by_id["care.input"]["status"] == "blocked"
    assert by_id["care.input"]["reason"] == "upstream-needs-input"
    assert by_id["input.verify"]["status"] == "blocked"


def test_gated_routes_are_unique_across_features(tmp_path):
    service = json.dumps(str(ROOT / "server" / "services" / "feature_registry.js"))
    source = f"""
      const r=require({service}).loadRegistry({{force:true}});
      const seen=new Map(); const duplicate=[];
      for(const feature of r.functions) for(const route of feature.routes||[]) {{
        if(route.gate===false) continue;
        const key=route.method+' '+route.path;
        if(seen.has(key)) duplicate.push([key,seen.get(key),feature.id]);
        else seen.set(key,feature.id);
      }}
      console.log(JSON.stringify(duplicate));
    """
    duplicates = json.loads(run_node(source, env={"EMR_RUNTIME_ROOT": str(tmp_path / "runtime")}))
    assert duplicates == []


def test_details_one_keeps_fetch_result_when_classification_is_optional():
    source = (ROOT / "server" / "routes" / "details.js").read_text(encoding="utf-8")
    service = (ROOT / "server" / "services" / "order_pipeline.js").read_text(encoding="utf-8")
    assert "getFeature('orders.classify')" in source
    assert "requested-fetch-only" in source
    assert "feature-disabled" in source
    assert "responseStatus = 207" in source
    assert "async function postprocessOrders" in service


def test_precheck_tokens_are_task_scoped_and_one_time(tmp_path):
    service = json.dumps(str(ROOT / "server" / "services" / "input_precheck_tokens.js"))
    session = json.dumps(str(ROOT / "server" / "services" / "session.js"))
    source = f"""
      const t=require({service}); const s=require({session});
      const ctx=s.buildRuntimePathsForSid('default');
      const targets={{patientIds:['P1'],patientDates:{{P1:['04/08/2026']}},taskType:'care'}};
      const issued=t.issueInputPrecheckToken(ctx,'input_care',targets,{{checked_count:1}});
      const first=t.validateAndConsumeInputPrecheckToken(ctx,'input_care',{{...targets,precheck_token:issued.precheck_token}});
      const reused=t.validateAndConsumeInputPrecheckToken(ctx,'input_care',{{...targets,precheck_token:issued.precheck_token}});
      const issued2=t.issueInputPrecheckToken(ctx,'input_care',targets,{{checked_count:1}});
      const wrongTask=t.validateAndConsumeInputPrecheckToken(ctx,'input_infusions',{{...targets,precheck_token:issued2.precheck_token}});
      console.log(JSON.stringify({{first,reused,wrongTask}}));
    """
    payload = json.loads(run_node(source, env={"EMR_RUNTIME_ROOT": str(tmp_path / "runtime")}))
    assert payload["first"]["ok"] is True
    assert payload["reused"]["ok"] is False
    assert payload["wrongTask"]["ok"] is False


def test_shift_ui_never_requests_client_side_precheck_bypass():
    source = (ROOT / "src" / "components" / "ShiftTab.jsx").read_text(encoding="utf-8")
    assert "targets.skipPrecheck = true" not in source
    assert source.count("targets.precheck_token = precheck.precheck_token") == 3
    assert "ensureInputDataFresh(targets, 'chăm sóc'" in source
    assert "ensureInputDataFresh(targets, 'dịch truyền'" in source
    assert "ensureInputDataFresh(targets, 'thủ thuật'" in source


def test_precheck_does_not_issue_token_when_classification_cannot_finish():
    source = (ROOT / "server" / "routes" / "patients.js").read_text(encoding="utf-8")
    assert "result.allow_input === false" in source
    assert "classification: { status: 'skipped', reason: 'feature-disabled' }" in source
    assert "restoreRuntimeFile(ctx.FINAL_PATH" in source
    assert "restoreRuntimeFile(ctx.PROCESSED_PATH" in source


def test_clinic_care_precheck_is_separate_exact_and_one_time(tmp_path):
    service = json.dumps(str(ROOT / "server" / "services" / "input_precheck_tokens.js"))
    source = f"""
      const t=require({service});
      const ctx={{dir:{json.dumps(str(tmp_path / 'session'))},STATE_DIR:{json.dumps(str(tmp_path / 'session' / 'state'))}}};
      const exact={{patientIds:['99070001|08:25 20/07/2026|noi-1|khoa khám bệnh','context|login|list|khoa khám bệnh|ĐD A|Nội dung|Diễn biến|vitals:0'],selectedDates:['20/07/2026']}};
      const issued=t.issueInputPrecheckToken(ctx,'clinic_input_care',exact,{{checked_count:1}});
      const wrongTask=t.validateAndConsumeInputPrecheckToken(ctx,'input_care',{{...exact,precheck_token:issued.precheck_token}});
      const issued2=t.issueInputPrecheckToken(ctx,'clinic_input_care',exact,{{checked_count:1}});
      const changed={{...exact,patientIds:[...exact.patientIds.slice(0,1),'context|login|list|khoa khám bệnh|ĐD B|Nội dung|Diễn biến|vitals:0']}};
      const wrongContext=t.validateAndConsumeInputPrecheckToken(ctx,'clinic_input_care',{{...changed,precheck_token:issued2.precheck_token}});
      const issued3=t.issueInputPrecheckToken(ctx,'clinic_input_care',exact,{{checked_count:1}});
      const first=t.validateAndConsumeInputPrecheckToken(ctx,'clinic_input_care',{{...exact,precheck_token:issued3.precheck_token}});
      const reused=t.validateAndConsumeInputPrecheckToken(ctx,'clinic_input_care',{{...exact,precheck_token:issued3.precheck_token}});
      console.log(JSON.stringify({{wrongTask,wrongContext,first,reused,normalized:t.normalizeTaskName('clinic-care')}}));
    """
    payload = json.loads(run_node(source))
    assert payload["wrongTask"]["ok"] is False
    assert payload["wrongContext"]["ok"] is False
    assert payload["first"]["ok"] is True
    assert payload["reused"]["ok"] is False
    assert payload["normalized"] == "clinic_input_care"


def test_clinic_care_ui_is_a_subtab_and_requires_preview_token():
    source = (ROOT / "src" / "components" / "ClinicTab.jsx").read_text(encoding="utf-8")
    routes = (ROOT / "server" / "routes" / "clinic.js").read_text(encoding="utf-8")
    rate_limits = (ROOT / "server" / "routes" / "index.js").read_text(encoding="utf-8")
    assert "activeSection === 'care'" in source
    assert "Nhập chăm sóc" in source
    assert "precheck_token: carePreview.precheck_token" in source
    assert "!carePreview?.precheck_token" in source
    assert "issueInputPrecheckToken" in routes
    assert "validateAndConsumeInputPrecheckToken" in routes
    assert "'clinic_input_care'" in routes
    assert "'/clinic/care-preview'" in rate_limits
    assert "'/clinic/input-care'" in rate_limits
