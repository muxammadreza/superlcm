import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveRatioPolicy, ratioOptions, automaticRatios } from '../dsh/ratio-policy.js'
import { selectRollingRange } from '../dsh/rolling.js'
import { controlsConfig } from '../dsh/controls-config.js'

test('thresholds use current input capacity after output reservation',()=>{
  const policy=deriveRatioPolicy({foldBatchTokens:20000},{contextWindow:1000000,reservedCompletionTokens:100000})
  assert.equal(policy.prepareActiveTokens,630000)
  assert.equal(policy.softActiveTokens,720000)
  assert.equal(policy.hardActiveTokens,810000)
  assert.equal(policy.minRetainTokens,36000)
  assert.equal(policy.summaryPrefixTargetTokens,54000)
  assert.equal(policy.postTargetTokens,90000)
})
test('fixed tools and system costs count toward the post-compaction target',()=>{
  const policy=deriveRatioPolicy({foldBatchTokens:20000},{contextWindow:100000,fixedTokens:12000})
  assert.equal(policy.minRetainTokens,4000)
  assert.equal(policy.postTargetTokens,22000)
  assert.equal(policy.summaryPrefixTargetTokens,6000)
  const small=deriveRatioPolicy({foldBatchTokens:20000},{contextWindow:8000})
  assert.ok(small.foldBatchTokens<20000)
  assert.ok(small.minRetainTokens+small.summaryPrefixTargetTokens<small.softActiveTokens)
  assert.throws(()=>deriveRatioPolicy({foldBatchTokens:20000},{contextWindow:8000,fixedTokens:6500}))
})
test('large fixed costs keep a viable summary budget below the normal switch threshold',()=>{
  const policy=deriveRatioPolicy({foldBatchTokens:20000},{contextWindow:500000,fixedTokens:48385})
  assert.equal(policy.summaryPrefixTargetTokens,30000)
  assert.equal(policy.postTargetTokens,98385)
  assert.equal(policy.postTargetTokens,48385+policy.minRetainTokens+policy.summaryPrefixTargetTokens)
  assert.ok(policy.postTargetTokens<policy.softActiveTokens)
  assert.throws(()=>deriveRatioPolicy({foldBatchTokens:20000},{contextWindow:100000,fixedTokens:78000}),/无法容纳/)
})
test('unknown capacities and unordered thresholds are rejected',()=>{
  assert.throws(()=>deriveRatioPolicy({foldBatchTokens:20000},{}))
  assert.throws(()=>deriveRatioPolicy({foldBatchTokens:20000},{contextWindow:8000,reservedCompletionTokens:8000}))
  assert.throws(()=>ratioOptions({prepareRatio:.9,switchRatio:.8}))
})
test('latest user turn stays verbatim even when it exceeds the usual recent budget',()=>{
  const nodes=[0,1,2,3,4].map(seq=>({seq,tokens:1000}))
  const selection=selectRollingRange(nodes,[0,1,2,3,4],{firstFoldableIndex:0,protectedFromIndex:2,
    minRetainTokens:1000,retainTokenBudget:true,foldBatchTokens:2000,softActiveTokens:3000,hardActiveTokens:4000})
  assert.equal(selection.end,1)
  assert.equal(selection.eligibleEnd,1)
})
test('fresh controls default to ratios and 20K chunks while old fixed-token controls remain explicit',()=>{
  assert.equal(controlsConfig({auto:false}).budgetMode,'ratio')
  assert.equal(controlsConfig({auto:false}).foldBatchTokens,20000)
  assert.equal(controlsConfig({auto:false,softActiveTokens:260000,hardActiveTokens:280000}).budgetMode,'tokens')
})

test('a 10K ratio chunk does not inherit an incompatible hidden legacy pressure minimum',()=>{
  const config=controlsConfig({auto:false,budgetMode:'ratio',foldBatchTokens:10000,pressureFoldTokens:20000})
  assert.equal(config.foldBatchTokens,10000)
  assert.equal(config.pressureFoldTokens,10000)
})

test('user thresholds scale with each model window and its output reservation',()=>{
  const base={foldBatchTokens:20000,prepareRatio:.6,switchRatio:.82,emergencyRatio:.95}
  const small=deriveRatioPolicy(base,{contextWindow:100000,reservedCompletionTokens:10000})
  const large=deriveRatioPolicy(base,{contextWindow:1000000,reservedCompletionTokens:100000})
  assert.equal(small.prepareActiveTokens,54000);assert.equal(small.softActiveTokens,73800);assert.equal(small.hardActiveTokens,85500)
  assert.equal(large.prepareActiveTokens,540000);assert.equal(large.softActiveTokens,738000);assert.equal(large.hardActiveTokens,855000)
})

test('legal early thresholds shrink automatic retention and summary budgets too',()=>{
  const policy=deriveRatioPolicy({foldBatchTokens:20000,prepareRatio:.01,switchRatio:.02,emergencyRatio:.03},{contextWindow:100000})
  assert.equal(policy.softActiveTokens,2000);assert.equal(policy.minRetainTokens,300)
  assert.ok(policy.foldBatchTokens>=512)
  assert.ok(policy.minRetainTokens+policy.summaryPrefixTargetTokens<policy.softActiveTokens)
})

test('one compaction threshold arranges preparation and safety automatically',()=>{
  assert.deepEqual(automaticRatios(.8),{prepareRatio:.7,switchRatio:.8,emergencyRatio:.9})
  for(const ratio of [.11,.5,.7,.85,.9,.99]){const x=automaticRatios(ratio);assert.equal(x.switchRatio,ratio);assert.ok(x.prepareRatio>0&&x.prepareRatio<ratio);assert.ok(x.emergencyRatio>ratio&&x.emergencyRatio<1)}
  for(const ratio of [0,.1,1,NaN,Infinity,'0.8'])assert.throws(()=>automaticRatios(ratio),/压缩比例/)
})

test('recent-original presets are honored and shrink safely with the routed input budget',()=>{
 const p=keep=>deriveRatioPolicy({foldBatchTokens:20000,keepRecentTokens:keep},{contextWindow:1000000,reservedCompletionTokens:100000})
 assert.equal(p(20000).minRetainTokens,20000);assert.equal(p(80000).minRetainTokens,80000)
 const small=deriveRatioPolicy({foldBatchTokens:20000,keepRecentTokens:200000,...automaticRatios(.5)},{contextWindow:64000,reservedCompletionTokens:16000,fixedTokens:4000})
 assert.equal(small.minRetainTokens,10000)
 assert.ok(small.minRetainTokens+small.summaryPrefixTargetTokens+4000<small.softActiveTokens)
 assert.ok(small.postTargetTokens<small.hardActiveTokens)
 assert.equal(small.protectLatestUser,true)
 for(const keep of [null,0,4999,200001,Infinity,5000.5])assert.throws(()=>p(keep),/原文保留/)
})

test('configured retention uses half the active dialogue rather than half an empty model window',()=>{
 const p=deriveRatioPolicy({foldBatchTokens:20000,keepRecentTokens:80000},{contextWindow:100000,activeTokens:30000,fixedTokens:4000})
 assert.equal(p.minRetainTokens,13000)
})
