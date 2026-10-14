const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'src', 'pose', 'poses', 'scenes.json');
const DURATION = 7000;

const specs = [
  ['relaxed-confidence','Relaxed Confidence','professional',['solo'],'both',true,['confidence'],['confident'],'Turn slightly','Shift your weight','Relax your hands','Confident eyes'],
  ['power-stance','Power Stance','professional',['solo'],'full',true,['power'],['determined'],'Step wide','Stand tall','Set your fists','Own the camera'],
  ['editorial-s-curve','Editorial S-Curve','glamour',['solo'],'full',false,['sCurve'],['confident'],'Shift one hip','Angle your shoulders','Place one hand','Soft model eyes'],
  ['pocket-angle','Pocket Angle','professional',['solo'],'both',false,['pocket'],['smirk'],'Turn your body','Bend one knee','Hand near pocket','Give a small smirk'],
  ['shoulder-turn','Shoulder Turn','glamour',['solo'],'half',false,['shoulderTurn'],['confident'],'Turn away','Bring one shoulder back','Look over it','Hold that gaze'],
  ['crossed-arms-cool','Crossed Arms Cool','professional',['solo'],'half',true,['crossed'],['confident'],'Turn slightly','Lower your shoulders','Cross your arms','Cool confident face'],
  ['walking-camera','Walk to Camera','solo',['solo'],'full',true,['walk'],['bigSmile'],'Step forward','Let your arms move','Lift your chin','Smile as you walk'],
  ['peace-and-wink','Peace and Wink','cute',['solo'],'both',true,['peace'],['wink'],'Raise one hand','Make a peace sign','Tilt your head','Smile and wink'],
  ['double-peace','Double Peace','cute',['solo'],'half',true,['doublePeace'],['happyEyes'],'Lift both hands','Make two peace signs','Tilt your head','Big happy eyes'],
  ['hands-on-cheeks','Hands on Cheeks','cute',['solo'],'half',true,['cheeks'],['surprised'],'Lift both hands','Touch your cheeks','Tilt your head','Big surprise'],
  ['heart-hands','Heart Hands','cute',['solo'],'half',true,['heart'],['bigSmile'],'Raise your hands','Bring them together','Make a heart','Smile through it'],
  ['shy-toe-turn','Shy Toe Turn','cute',['solo'],'full',true,['shy'],['smile'],'Turn your toes in','Bring hands together','Tilt your head','Give a shy smile'],
  ['superhero-landing','Superhero Landing','funny',['solo'],'full',true,['superhero'],['determined'],'Step wide','Drop one knee','Plant your fist','Hero eyes up'],
  ['anime-power-up','Anime Power-Up','party',['solo'],'full',true,['powerUp'],['determined'],'Step wide','Bend your knees','Clench your fists','Power up!'],
  ['magical-transformation','Magical Transformation','party',['solo'],'full',true,['transform'],['bigSmile'],'Turn one foot','Twist your body','Sweep your arms up','Transformation finish!'],
  ['cool-villain','Cool Villain','funny',['solo'],'both',true,['villain'],['villain'],'Turn into shadow','Raise one hand','Lower your chin','Give a villain smirk'],
  ['secret-agent-dodge','Secret Agent Dodge','funny',['solo'],'full',true,['dodge'],['panic'],'Step sideways','Lean away','Throw your arms out','Dodge the laser!'],
  ['comic-hero-punch','Comic Hero Punch','party',['solo'],'both',true,['punch'],['determined'],'Set your feet','Turn your shoulder','Punch toward camera','Hero face'],
  ['broken-doll-fashion','Broken-Doll Fashion','glamour',['solo'],'full',false,['brokenDoll'],['deadpan'],'Break your hip line','Tilt your shoulders','Bend your wrists','Blank fashion face'],
  ['runway-cross-step','Runway Cross-Step','glamour',['solo'],'full',false,['runway'],['confident'],'Cross one step','Lengthen your body','Relax your arms','Runway eyes'],
  ['vogue-geometry','Vogue Geometry','glamour',['solo'],'half',false,['vogue'],['smirk'],'Angle your shoulders','Lift both elbows','Frame your face','Editorial smirk'],
  ['pop-star-finish','Pop-Star Finish','party',['solo'],'full',true,['popstar'],['bigSmile'],'Step to the side','Reach one arm high','Grab the imaginary mic','Big stage smile'],
  ['drama-queen','Drama Queen','funny',['solo'],'both',true,['drama'],['panic'],'Lift your chest','Throw hands upward','Tip your head back','Maximum drama!'],
  ['rock-star-lean','Rock-Star Lean','party',['solo'],'full',true,['rockstar'],['villain'],'Step wide','Lean backward','Play air guitar','Rock-star face'],

  ['back-to-back-agents','Back-to-Back Agents','friends',['couple','friends'],'both',true,['crossed','crossed'],['determined','smirk'],'Stand back-to-back','Cross your arms','Look opposite ways','Secret-agent faces'],
  ['anime-rivals','Anime Rivals','friends',['couple','friends'],'full',true,['powerUp','powerUp'],['determined','villain'],'Face each other','Take battle stances','Ready your fists','Rival eyes'],
  ['hero-and-sidekick','Hero and Sidekick','friends',['friends','family'],'both',true,['power','peace'],['determined','bigSmile'],'Hero steps forward','Sidekick peeks out','Strike your signs','Save the world'],
  ['power-couple','Power Couple','couple',['couple'],'both',false,['sCurve','power'],['confident','smirk'],'Stand shoulder-to-shoulder','Angle outward','Set your hands','Power-couple eyes'],
  ['cinematic-almost-kiss','Cinematic Almost Kiss','couple',['couple'],'half',false,['leanRight','leanLeft'],['kiss','closedEyes'],'Turn toward each other','Move close','Hold at the waist','Almost kiss'],
  ['forehead-touch','Forehead Touch','couple',['couple'],'half',false,['leanRight','leanLeft'],['closedEyes','closedEyes'],'Face each other','Step close','Touch foreheads','Close your eyes'],
  ['dip-and-laugh','Dip and Laugh','couple',['couple'],'full',false,['guard','leanRight'],['bigSmile','bigSmile'],'Connect hands','Support the waist','Make a tiny dip','Laugh together'],
  ['kneeling-proposal','Kneeling Proposal','couple',['couple'],'full',false,['kneel','drama'],['confident','surprised'],'One person kneels','Present the ring','React with both hands','Big surprise!'],
  ['royal-and-bodyguard','Royal and Bodyguard','friends',['friends','couple'],'full',true,['sCurve','guard'],['smirk','determined'],'Royal steps forward','Guard stands behind','Set your roles','Regal and serious'],
  ['mirror-twins','Mirror Twins','friends',['friends','couple'],'both',true,['vogue','vogue'],['deadpan','deadpan'],'Stand shoulder-to-shoulder','Mirror your bodies','Match your hands','Twin fashion faces'],
  ['fashion-push-pull','Fashion Push-Pull','glamour',['couple','friends'],'full',false,['leanLeft','leanRight'],['smirk','confident'],'Connect one hand','Lean apart','Stretch the line','Model eyes'],
  ['secret-and-shock','Secret and Shock','funny',['friends','couple'],'half',true,['whisper','listen'],['smirk','panic'],'Lean together','Whisper the secret','Turn to camera','Huge shock!'],

  ['spy-trio','Spy Trio','friends',['friends','group'],'both',true,['guard','crossed','point'],['determined','smirk','suspicious'],'Make a triangle','Turn three directions','Ready your hands','Spy faces'],
  ['editorial-triangle','Editorial Triangle','glamour',['friends','group'],'both',false,['kneel','sCurve','shoulderTurn'],['deadpan','confident','smirk'],'Build three levels','Angle toward center','Shape your arms','Fashion stillness'],
  ['anime-squad-three','Anime Squad Trio','party',['friends','family','group'],'full',true,['power','powerUp','transform'],['determined','villain','bigSmile'],'Leader steps forward','Teammates fan out','Power poses ready','Squad faces'],
  ['face-totem-three','Three-Face Totem','funny',['friends','family','group'],'half',true,['leanRight','relaxed','leanLeft'],['suspicious','bigSmile','panic'],'Stack diagonally','Lean into view','Keep every face clear','Three wild reactions'],
  ['center-superstar-three','Center Superstar','party',['friends','family','group'],'half',true,['present','sCurve','present'],['surprised','smirk','bigSmile'],'Center takes the mark','Sides lean inward','Present the star','Star stays cool'],
  ['three-level-fashion','Three-Level Fashion','glamour',['friends','group'],'full',false,['kneel','brokenDoll','runway'],['deadpan','smirk','confident'],'Choose three heights','Overlap shoulders','Make sharp lines','Editorial faces'],
  ['see-hear-speak-chaos','See Hear Speak Chaos','funny',['friends','family','group'],'half',true,['cheeks','listen','drama'],['panic','suspicious','awkward'],'Line up close','Cover eyes ears mouth','Lean together','Make it chaotic'],
  ['domino-lean-three','Domino Lean','funny',['friends','family','group'],'both',true,['leanRight','leanRight','leanRight'],['bigSmile','surprised','panic'],'Stand in a row','Lean one direction','Increase each angle','Hold the domino'],

  ['action-movie-diamond','Action-Movie Diamond','party',['friends','group'],'both',true,['kneel','guard','point','power'],['determined','smirk','suspicious','villain'],'Build a diamond','Turn four directions','Ready action hands','Movie-poster faces'],
  ['fashion-album-cover','Fashion Album Cover','glamour',['friends','group'],'both',false,['brokenDoll','runway','vogue','shoulderTurn'],['deadpan','confident','smirk','suspicious'],'Make four levels','Overlap the group','Choose different angles','Album-cover faces'],
  ['human-picture-frame','Human Picture Frame','friends',['friends','family','group'],'half',true,['present','peace','heart','present'],['bigSmile','wink','happyEyes','surprised'],'Outside guests frame','Inside guests move close','Build the picture','Everyone reacts'],
  ['anime-team-four','Anime Team Four','party',['friends','family','group'],'full',true,['power','guard','transform','powerUp'],['determined','villain','bigSmile','smirk'],'Leader steps forward','Team fans behind','Choose powers','Final battle faces'],
  ['emotion-explosion-four','Emotion Explosion','funny',['friends','family','group'],'half',true,['relaxed','listen','cheeks','drama'],['deadpan','suspicious','surprised','panic'],'Line up tightly','Look down the line','Pass the reaction','Explode at the end'],
  ['accusation-circle-four','Accusation Circle','funny',['friends','family','group'],'half',true,['point','point','point','point'],['suspicious','panic','awkward','villain'],'Turn toward center','Point to someone else','Look at camera','Who did it?'],
  ['red-carpet-drama-four','Red-Carpet Drama','party',['friends','group'],'both',false,['sCurve','guard','camera','drama'],['confident','determined','bigSmile','panic'],'Star takes the center','Bodyguard steps close','Paparazzi aims','Fan loses control'],
  ['sit-kneel-lean-stand','Four-Level Editorial','glamour',['friends','group'],'full',false,['kneel','kneel','leanLeft','runway'],['deadpan','smirk','confident','suspicious'],'Choose four heights','Build a diagonal','Overlap carefully','Freeze like fashion'],

  ['ensemble-movie-poster','Ensemble Movie Poster','group',['group','friends'],'both',true,['power','guard','point','vogue','drama'],['determined','smirk','suspicious','villain','panic'],'Choose the hero','Build layers behind','Give everyone a role','Movie-poster finish'],
  ['fashion-dynasty','Fashion Dynasty','glamour',['group','friends'],'both',false,['sCurve','runway','brokenDoll','shoulderTurn','vogue'],['confident','deadpan','smirk','suspicious','villain'],'Build a fashion pyramid','Overlap shoulders','Vary every angle','Dynasty faces'],
  ['celebration-eruption','Celebration Eruption','party',['group','friends','family'],'both',true,['peace','doublePeace','armsUp','drama','popstar'],['smile','bigSmile','happyEyes','surprised','panic'],'Center starts calm','Raise hands outward','Grow the energy','Celebration erupts!'],
  ['group-power-up','Group Power-Up','party',['group','friends','family'],'full',true,['power','powerUp','transform','superhero','guard'],['determined','villain','bigSmile','smirk','panic'],'Spread into formation','Bend your knees','Choose your power','Power up together!'],
  ['human-wave','Human Wave','funny',['group','friends','family'],'half',true,['leanLeft','leanLeft','relaxed','leanRight','leanRight'],['panic','surprised','bigSmile','suspicious','villain'],'Form a close line','Start leaning outside','Build a wave','Hold the wave'],
  ['many-armed-idol','Many-Armed Idol','party',['group','friends','family'],'half',true,['relaxed','armsUp','vogue','present','doublePeace'],['confident','bigSmile','deadpan','smirk','happyEyes'],'Choose the center idol','Hide behind in layers','Fan every arm outward','Idol face'],
  ['royal-court','Royal Court','funny',['group','friends','family'],'both',true,['sCurve','kneel','guard','present','whisper'],['villain','bigSmile','determined','awkward','suspicious'],'Royal takes the center','Court forms around','Choose your court role','Royal drama'],
  ['heroes-vs-villains','Heroes Versus Villains','party',['group','friends','family'],'both',true,['power','superhero','villain','powerUp','dodge'],['determined','smirk','villain','suspicious','panic'],'Split into two teams','Face the center','Ready your powers','Heroes versus villains!'],

  ['family-superhero-team','Family Superhero Team','family',['family'],'both',true,['guard','power','superhero'],['determined','smirk','bigSmile'],'Adults anchor behind','Hero steps forward','Everyone powers up','Family saves the day'],
  ['parents-as-bodyguards','Parents as Bodyguards','family',['family'],'both',true,['guard','guard','sCurve'],['determined','determined','smirk'],'Star stands in front','Guards close behind','Set protective hands','Cool family faces'],
  ['kids-take-over','Kids Take Over','family',['family'],'half',true,['sCurve','kneel','drama'],['smirk','determined','panic'],'Kids take the center','Adults move behind','Kids act like bosses','Adults look worried'],
  ['family-squeeze-attack','Family Squeeze Attack','family',['family'],'half',true,['leanRight','cheeks','leanLeft'],['bigSmile','happyEyes','bigSmile'],'Move close together','Lean toward the center','Squeeze gently','Laugh at the camera'],
  ['tiny-hero-big-villains','Tiny Hero Big Villains','kids',['family'],'both',true,['superhero','dodge','drama'],['determined','panic','panic'],'Tiny hero steps forward','Villains loom behind','Hero powers up','Villains are defeated'],
  ['copy-the-child','Copy the Child','kids',['family'],'both',true,['doublePeace','doublePeace','doublePeace'],['bigSmile','awkward','awkward'],'Child chooses the pose','Adults copy the body','Match every hand','Child does it best'],
  ['animal-family','Animal Family','kids',['family','friends','group'],'half',true,['animal','animal','animal'],['bigSmile','villain','panic'],'Choose your animals','Make ears and paws','Lean into the pack','Animal faces!'],
  ['parent-puppet-show','Parent Puppet Show','kids',['family'],'both',true,['transform','brokenDoll','brokenDoll'],['smirk','deadpan','deadpan'],'Puppet master in front','Adults become puppets','Bend strange angles','Freeze!'],
  ['family-duo-power','Family Duo Power-Up','family',['family'],'both',true,['power','superhero'],['determined','bigSmile'],'Stand shoulder-to-shoulder','Take two power stances','Ready your fists','Family power-up!'],
  ['family-duo-squeeze','Family Duo Squeeze','family',['family'],'half',true,['leanRight','leanLeft'],['bigSmile','happyEyes'],'Move close together','Lean toward the middle','Touch shoulders','Squeeze and smile'],
  ['parent-child-agents','Parent and Child Agents','family',['family'],'both',true,['guard','peace'],['determined','smirk'],'Stand back-to-back','Choose agent poses','Set your hands','Secret-agent faces'],
  ['copy-the-child-duo','Copy the Child Duo','kids',['family'],'both',true,['doublePeace','doublePeace'],['bigSmile','awkward'],'Child takes the lead','Adult copies the body','Match both hands','Child wins!'],

  ['cinematic-back-hug','Cinematic Back Hug','wedding',['couple'],'both',false,['leanRight','guard'],['closedEyes','smile'],'Stand front and back','Wrap arms gently','Turn your heads','Soft cinematic eyes'],
  ['runaway-newlyweds','Runaway Newlyweds','wedding',['couple'],'full',false,['walk','walk'],['bigSmile','bigSmile'],'Connect inside hands','Step forward together','Lean into the run','Laugh toward camera'],
  ['spy-newlyweds','Spy Newlyweds','wedding',['couple'],'both',false,['crossed','crossed'],['determined','smirk'],'Stand back-to-back','Cross your arms','Turn opposite ways','Wedding spies'],
  ['kiss-with-reaction','Kiss with Group Reaction','wedding',['group'],'half',false,['leanRight','leanLeft','drama','cheeks','armsUp'],['kiss','kiss','panic','surprised','bigSmile'],'Couple takes the center','Friends crowd around','Couple leans in','Everyone reacts!'],
  ['dance-battle-freeze','Dance Battle Freeze','party',['friends','group'],'full',true,['popstar','rockstar','vogue','dodge'],['bigSmile','villain','smirk','panic'],'Split into dance teams','Start your moves','Freeze mid-battle','Dance faces'],
  ['invisible-roller-coaster','Invisible Roller Coaster','funny',['friends','family','group'],'half',true,['leanLeft','leanLeft','leanLeft','leanLeft'],['bigSmile','surprised','panic','happyEyes'],'Make one tight row','Grab the safety bar','Lean through the turn','Roller-coaster faces!'],
  ['zombie-fashion-show','Zombie Fashion Show','funny',['friends','group'],'both',true,['runway','brokenDoll','vogue','walk'],['deadpan','villain','awkward','panic'],'Enter the runway','Break your body lines','Reach like zombies','Dead-serious fashion'],
  ['alien-abduction','Alien Abduction','funny',['friends','family','group'],'full',true,['armsUp','guard','scared','drama'],['panic','determined','surprised','panic'],'Target reaches upward','Others grab on','Fight the tractor beam','Alien panic!'],

  // Compatibility IDs retained for templates and settings created with the prototype pack.
  ['couple-heart','Couple Heart','couple',['couple'],'both',false,['heart','heart'],['bigSmile','happyEyes'],'Stand close together','Raise both hands','Build matching hearts','Smile together'],
  ['couple-peace','Peace Together','couple',['couple'],'both',false,['peace','peace'],['wink','bigSmile'],'Stand shoulder-to-shoulder','Raise one hand each','Make peace signs','Smile and wink'],
  ['friends-peace','Peace Party','friends',['friends','group'],'both',true,['doublePeace','peace'],['bigSmile','wink'],'Move close together','Raise your hands','Fill the frame with peace','Party smiles'],
  ['friends-cheeks','Cheeky Smiles','friends',['friends','group'],'half',true,['cheeks','cheeks'],['surprised','happyEyes'],'Move close together','Lift both hands','Touch your cheeks','Cheeky faces'],
  ['family-heart','Family Hearts','family',['family'],'half',true,['heart','heart','heart'],['bigSmile','happyEyes','smile'],'Build a family cluster','Raise your hands','Make matching hearts','Family smiles'],
  ['family-peace','Family Peace','family',['family'],'both',true,['peace','doublePeace','peace'],['wink','bigSmile','happyEyes'],'Build three levels','Raise your hands','Make peace signs','Smile together'],
  ['group-freestyle','Group Freestyle','friends',['friends','family','group'],'both',true,['power','vogue','drama','peace','rockstar'],['determined','smirk','panic','wink','villain'],'Fill the frame','Choose different body lines','Make every face unique','Freeze the chaos']
];

function makeScene(row) {
  const [id,name,category,styles,framing,childSafe,archetypes,expressions,...cues] = row;
  const count = archetypes.length;
  const flexible = count >= 5 || (['family','group'].includes(category) && count === 3);
  const formation = count === 3 ? 'triangle' : count === 4 ? 'diamond' : count >= 5 ? 'layers' : 'pair';
  const adultOnly = !childSafe;
  const roles = category === 'kids' ? ['child', ...Array(count - 1).fill('adult')] : Array(count).fill(adultOnly ? 'adult':'any');
  return {
    schemaVersion:2, id, name, category,
    tags:['playful-library','four-second',`formation-${formation}`,`expression-${expressions[0]}`, adultOnly?'adult-only':'child-safe', count > 1?'cooperative':'solo'].filter(Boolean),
    instruction:cues.at(-1),
    animation:{ durationMs:DURATION, captions:cues.map((text,index)=>({timeMs:index*500,text})) },
    compatibility:{ minPeople:count, maxPeople:flexible?null:count, styles, framing:framing === 'both'?['full','half']:[framing], childSafe },
    roles:roles.map((role,index)=>({ role, repeatable:flexible && index === count - 1 }))
  };
}

const creative = require('./creative-pose-pack.cjs');
const memes = require('./meme-pose-pack.cjs').map(pose => pose.scene);
const scenes = [...specs.map(makeScene), ...creative, ...memes];
const ids = scenes.map(scene => scene.id);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate pose id in generated library');
fs.writeFileSync(OUT, `${JSON.stringify(scenes, null, 2)}\n`);
console.log(`Wrote ${scenes.length} four-second scenes to ${OUT}`);
