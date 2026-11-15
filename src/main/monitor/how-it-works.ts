/**
 * Static "How it works" tab of the Learning Monitor: how Triage's learning
 * actually works and how to implement it. Plain HTML (no scripts), inserted
 * into the monitor page. Keep it in sync with the code it names.
 */
export const HOW_IT_WORKS = String.raw`
<h2>The short version</h2>
<p>Triage adapts to one older person at a time. It learns <strong>which page layout suits them</strong>, <strong>what they already know how to do</strong>, and <strong>their personal details</strong> (pharmacy, prescriptions), and it carries out multi-step tasks with saved progress. A large language model writes the simplified pages and understands requests, but Triage does not train it.</p>
<div class="callout"><strong>Is this deep learning?</strong> Honestly, not yet in the narrow sense: there is no neural network that Triage trains. The parts that learn are Bayesian models chosen because they learn well from tens of interactions, not millions, and because they can explain and bound their own uncertainty. The last section shows exactly where a neural network fits once enough data exists.</div>
<table>
  <tr><th>What it learns</th><th>Model</th><th>Learns from</th><th>Code</th></tr>
  <tr><td>Which layout to show</td><td>Hierarchical Bayesian linear Thompson sampling (contextual bandit)</td><td>Ratings and implicit signals per simplified page</td><td><code>simplifier/thompson.ts</code></td></tr>
  <tr><td>What the person knows</td><td>Bayesian Knowledge Tracing</td><td>Doing a task alone, clicking a highlighted control, asking how</td><td><code>skills/bkt.ts</code></td></tr>
  <tr><td>Personal details</td><td>Vector memory with a LangChain retriever</td><td>"Remember that…" and answers given during tasks</td><td><code>memory/</code></td></tr>
  <tr><td>Multi-step tasks</td><td>LangGraph state machine with checkpoints</td><td>Each step; saves a reusable recipe on success</td><td><code>tasks/</code></td></tr>
  <tr><td>Page rewriting, request routing</td><td>Hosted LLM (Gemini or Claude), not trained here</td><td>Nothing; it is prompted with structured page data</td><td><code>simplifier/llm.ts</code></td></tr>
</table>

<h2>How one request flows</h2>
<div class="flow-diagram">
  <span class="box">Chat or voice</span><span class="arrow">→</span>
  <span class="box">Rules pick the route (no model)</span><span class="arrow">→</span>
  <span class="box">LangGraph task, or LangChain simplifier pipeline</span><span class="arrow">→</span>
  <span class="box">Memory retriever · layout bandit · LLM</span><span class="arrow">→</span>
  <span class="box">Reply, simplified page, or a pause for "yes"</span>
</div>
<p>Every LangChain and LangGraph run reports to this monitor through LangChain's own callback system (<code>monitor/callbacks.ts</code>), so the Live tab shows what actually executed, not a description of it.</p>

<h2>1. Layout learning: a contextual bandit</h2>
<p>Each time a page is simplified, Triage must choose one of ten <em>layouts</em> (arms): text size 1.25×, 1.5× or 2×; 3 or 6 buttons; plain language on or off; read aloud on or off. It is a bandit problem: Triage only learns how well the layout it showed worked, never how the others would have done.</p>
<h3>Context: what Triage knows when it chooses</h3>
<p>A vector <code>x</code> of 18 numbers: a bias term, the page type (article, form, checkout, login, email, other), page complexity (number of controls, menu depth, text length), time of day (as sine and cosine), whether voice is on, the person's recent error rate, and four skill features from knowledge tracing (how well they know this page's skill and its prerequisites).</p>
<h3>Reward: did it help?</h3>
<pre><code>r = 0.5·completed + 0.2·(1 − time/expected) + 0.15·no_backtracking + 0.15·thumbs_up
    − 0.25·asked_for_original − 0.05·repeats            (clipped to 0…1)</code></pre>
<h3>Model: Bayesian linear regression per layout, with learned noise</h3>
<p>For person <code>u</code> and layout <code>a</code>, reward is modelled as <code>r ≈ θ·x + noise</code>, with a Normal-Inverse-Gamma posterior over both the weights <code>θ</code> and the noise variance <code>σ²</code>:</p>
<pre><code>Λₙ = λ·I + XᵀX                      precision (how sure we are)
μₙ = Λₙ⁻¹ (λ·m₀ + Xᵀr)              best estimate of the weights
aₙ = a₀ + n/2                        noise posterior shape
bₙ = b₀ + ½ (Σr² + λ·m₀ᵀm₀ − μₙᵀΛₙμₙ) noise posterior scale

σ² ~ InvGamma(aₙ, bₙ)
θ  ~ Normal(μₙ, v²·σ²·Λₙ⁻¹)</code></pre>
<p><strong>Choosing (Thompson sampling):</strong> draw one <code>θ</code> per layout from its posterior and show the layout with the highest <code>θ·x</code>. Layouts Triage is unsure about sometimes win a draw, so it keeps learning; layouts it is sure are good win almost always. The bars on the Live tab are the share of 200 such draws each layout wins.</p>
<h3>Hierarchical prior: new people do not start from zero</h3>
<p>The prior mean <code>m₀</code> for a person is the <em>population</em> estimate for that layout, learned from everyone. A new person starts from "what works for people in general" and drifts toward their own preferences as they rate pages.</p>
<h3>Research-based refinements</h3>
<table>
  <tr><th>Technique</th><th>What it does here</th><th>Source</th></tr>
  <tr><td>Normal-Inverse-Gamma posterior</td><td>Learns how noisy each person's ratings are. Consistent raters get confident faster; inconsistent ones keep exploring. Shown as "learned noise σ²" under each bar.</td><td>Riquelme, Tucker &amp; Snoek, <em>Deep Bayesian Bandits Showdown</em>, ICLR 2018</td></tr>
  <tr><td>Discounted statistics, γ = 0.98</td><td>Each new rating shrinks the weight of older ones by 2%, so the model follows changing needs (eyesight, fatigue, growing confidence). Effective memory about 50 ratings; "recent ratings" under each bar is this discounted count.</td><td>Russac, Vernade &amp; Cappé, NeurIPS 2019; Raj &amp; Kalyani 2017</td></tr>
  <tr><td>Narrowed sampling, v = 0.5</td><td>Halves the spread of draws: better early performance and less layout reshuffling for people who rely on consistency.</td><td>Chapelle &amp; Li, NeurIPS 2011</td></tr>
  <tr><td>Warm-up, freezing, shielding</td><td>Best guess for the first 3 pages of a type; lock a layout once one wins 90% of draws after 25 ratings; never explore on checkout or sign-in pages.</td><td>Design doc safety rules</td></tr>
  <tr><td>Posterior caching</td><td>Factorises each posterior once per rating instead of on every draw.</td><td>Engineering</td></tr>
</table>
<h3>Logging for later learning</h3>
<p>Every decision is stored as <code>(person, context x, layout, probability it was chosen, reward)</code>. The probability is what makes the log reusable: it lets new policies be evaluated on old data without showing them to anyone.</p>

<h2>2. Checking a new policy without risking anyone</h2>
<p>Off-policy evaluation estimates how a candidate policy <code>π</code> would have done on the logged decisions, where <code>p</code> is the logged probability and <code>w = π(a|x) / p</code>:</p>
<pre><code>IPS          = mean( w · r )
Clipped IPS  = mean( min(w, 10) · r )                      lower variance
SNIPS        = Σ w·r / Σ w                                 self-normalised
Doubly robust = mean( Σₐ π(a|x)·r̂(x,a) + w·(r − r̂(x,aᵢ)) )</code></pre>
<p><code>r̂</code> is a ridge-regression reward model per layout fitted on the logs. Doubly robust stays correct if <em>either</em> that model <em>or</em> the logged probabilities are right, and is far steadier on small logs (Dudík, Langford &amp; Li, ICML 2011). Code: <code>simplifier/off-policy.ts</code>.</p>

<h2>3. What the person knows: knowledge tracing</h2>
<p>For each skill (for example "find the Submit button"), Triage keeps <code>P(known)</code> and updates it after each opportunity (Corbett &amp; Anderson, 1995):</p>
<pre><code>right:  P(known | right) = P·(1−slip) / [ P·(1−slip) + (1−P)·guess ]
wrong:  P(known | wrong) = P·slip     / [ P·slip     + (1−P)·(1−guess) ]
then:   P ← P(known | outcome) + (1 − P(known | outcome))·learn</code></pre>
<p>Slip and guess depend on how much the opportunity proves: clicking a control Triage outlined is easy to get right by luck; finishing a task alone is not. These probabilities feed the layout bandit's context and decide when Triage stops explaining something.</p>

<h2>4. Memory: LangChain retrieval on the device</h2>
<ol>
  <li>A memory is a LangChain <code>Document</code>: text plus metadata (kind, key, e.g. <code>medication:blood pressure</code>, <code>rx</code>).</li>
  <li>An <code>Embeddings</code> class turns text into a 512-number vector by feature hashing words, word pairs and character trigrams (the hashing trick, Weinberger et al., ICML 2009), with a synonym table ("pills" ≈ "medication").</li>
  <li>A <code>VectorStore</code> keeps vectors in SQLite and ranks memories by cosine similarity.</li>
  <li>Task graphs query it through LangChain's standard <code>retriever.invoke(question)</code>; the Live tab shows each query, its matches and their similarity.</li>
</ol>
<p>Rules, not the model, decide what is stored, so text on a web page can never write to memory. Preferences have keys, so restating one replaces it.</p>

<h2>5. Multi-step tasks: LangGraph</h2>
<pre><code>recall → gather ⟲ → open → fill → confirm ⏸ → submit → remember</code></pre>
<p>Each node is a function that reads and updates a typed state. <code>gather</code> asks for one missing detail at a time and saves the answer to memory. <code>confirm</code> calls LangGraph's <code>interrupt()</code>: the graph stops, its state is checkpointed to SQLite, and it resumes with the person's reply, even after Triage restarts. The risk level of the submit button comes from rules over the page, never from a model, and payment or password pages are always refused.</p>

<h2>6. The language model's role</h2>
<p>The LLM rewrites a distilled page into a title, summary and a few buttons under the layout the bandit chose, using a fixed JSON format. Page text is passed as untrusted data, the model has no tools, and every button it returns must point at a real element on the page. If it fails or is slow, a rules-only rewrite is used, so the bandit always gets a layout to learn from.</p>

<h2>7. Implementing it, step by step</h2>
<ol>
  <li><strong>Distil pages</strong> into visible controls and text, dropping hidden content (<code>simplifier/distill.ts</code>, <code>context/</code>).</li>
  <li><strong>Classify</strong> page type and button risk with rules (<code>classify.ts</code>).</li>
  <li><strong>Build the context vector</strong> and keep its layout versioned (<code>features.ts</code>).</li>
  <li><strong>Choose a layout</strong> with the bandit; log the choice and its probability (<code>thompson.ts</code>, <code>decision-log.ts</code>).</li>
  <li><strong>Rewrite</strong> with the LLM inside a LangChain <code>RunnableSequence</code>, validating its output (<code>engine.ts</code>, <code>view.ts</code>).</li>
  <li><strong>Collect the outcome</strong> (time, backtracking, rating), turn it into a reward and update the posterior (<code>reward.ts</code>).</li>
  <li><strong>Run tasks</strong> as LangGraph graphs with a SQLite checkpointer and a memory retriever (<code>tasks/</code>, <code>memory/</code>).</li>
  <li><strong>Attach the callback handler</strong> to every run so the monitor sees it (<code>monitor/</code>).</li>
</ol>

<h2>8. Where deep learning fits next</h2>
<table>
  <tr><th>Step</th><th>Technique</th><th>Needs</th></tr>
  <tr><td>Learned page representation</td><td><strong>NeuralLinear</strong>: a small neural network turns the page and person into features; the Bayesian layer above it keeps the uncertainty that makes Thompson sampling work.</td><td>A few thousand logged decisions across people</td></tr>
  <tr><td>Better button ranking</td><td>A small model trained on which controls people click, replacing the hand-written importance score.</td><td>Click logs</td></tr>
  <tr><td>Semantic memory search</td><td>An on-device sentence-embedding model swapped in behind the same LangChain <code>Embeddings</code> interface.</td><td>Nothing new; a model download</td></tr>
  <tr><td>Whole-task policies</td><td>Offline reinforcement learning (Implicit Q-Learning) on the logged LangGraph trajectories, or preference tuning (DPO) of the planner on good and bad runs.</td><td>Hundreds of recorded tasks with outcomes</td></tr>
</table>
<p>Each step is evaluated first with the off-policy estimators above, on logged data, before anyone sees it.</p>

<h2>References</h2>
<ul>
  <li>Riquelme, Tucker &amp; Snoek. Deep Bayesian Bandits Showdown. ICLR 2018.</li>
  <li>Russac, Vernade &amp; Cappé. Weighted Linear Bandits for Non-Stationary Environments. NeurIPS 2019.</li>
  <li>Raj &amp; Kalyani. Taming Non-stationary Bandits: A Bayesian Approach. 2017.</li>
  <li>Chapelle &amp; Li. An Empirical Evaluation of Thompson Sampling. NeurIPS 2011.</li>
  <li>Dudík, Langford &amp; Li. Doubly Robust Policy Evaluation and Learning. ICML 2011.</li>
  <li>Bottou et al. Counterfactual Reasoning and Learning Systems. JMLR 2013.</li>
  <li>Corbett &amp; Anderson. Knowledge Tracing. User Modeling and User-Adapted Interaction, 1995.</li>
  <li>Weinberger et al. Feature Hashing for Large Scale Multitask Learning. ICML 2009.</li>
  <li>Marsaglia &amp; Tsang. A Simple Method for Generating Gamma Variables. ACM TOMS 2000.</li>
</ul>
`
