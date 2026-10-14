// The 40 poses selected for the October 2026 meme/photo-booth pack.
// Rows: slug, name, representative people, maximum people, framing, four spoken cues.
const rows = [
  ['six-seven','6–7 Hands',1,8,'half','Raise both hands','Turn your palms up','One high, one low','Hold your six seven'],
  ['six-seven-wave','6–7 Squad Wave',4,8,'half','Stand in a row','Palms facing up','Alternate high and low','Hold the squad wave'],
  ['aura-farmer','Aura Farmer',1,1,'full','Stand confidently','Relax your shoulders','Freeze your coolest move','Hold that aura'],
  ['aura-battle','Aura Battle',2,2,'full','Face each other','Choose a dramatic pose','Keep a serious face','Hold the aura battle'],
  ['main-character','Main Character + Crew',4,8,'full','Choose your main character','They step in front','Everyone else looks impressed','Hold your star moment'],
  ['jawline-check','Jawline Check',1,2,'half','Turn slightly sideways','Point along your jaw','Give a serious stare','Hold the jawline check'],
  ['sigma-smirk','Sigma Smirk',1,1,'half','Look into the lens','Raise one eyebrow','Make a tiny smirk','Hold the intense stare'],
  ['side-eye','Bombastic Side-Eye',2,8,'half','Keep your head forward','Look sharply sideways','Add a suspicious face','Hold that side eye'],
  ['rock-eyebrow','The Rock Eyebrow',1,2,'half','Face the camera','Raise one eyebrow','Look very suspicious','Hold that eyebrow'],
  ['absolute-cinema','Absolute Cinema',1,8,'half','Lift both hands','Open palms beside your head','Look dramatically impressed','Hold absolute cinema'],
  ['finger-heart','Finger Heart',1,8,'half','Lift one hand','Cross thumb and index finger','Bring the tiny heart near your face','Smile and hold'],
  ['double-finger-hearts','Double Finger Hearts',2,2,'half','Lift both hands','Make two tiny finger hearts','One beside each cheek','Smile together'],
  ['gyaru-peace','Gyaru Peace',2,6,'half','Make a peace sign','Angle your fingers downward','Reach toward the lens','Hold your playful smile'],
  ['cheek-heart','Cheek Heart',1,1,'half','Curve one hand','Make a half heart','Rest it against your cheek','Hold a sweet smile'],
  ['flower-face','Flower Face',2,2,'half','Open both palms','Put them beneath your chin','Tilt your head','Smile like a flower'],
  ['cat-paws','Cat Paws',3,6,'half','Lift hands beside your cheeks','Curl them like paws','Tilt your heads','Hold your cat faces'],
  ['cheek-poke','Cheek Poke',2,2,'half','Raise one index finger','Touch your own cheek','Smile or pout','Hold the cheek poke'],
  ['peace-wink','Double Peace + Wink',3,8,'half','Make two peace signs','Place them beside your eyes','Give the camera a wink','Hold the happy pose'],
  ['hand-goggles','Hand Goggles',2,6,'half','Make circles with your fingers','Hold them around your eyes','Look through your goggles','Freeze the silly face'],
  ['tiny-shy','Tiny Shy Pose',1,2,'half','Hands at chest height','Touch your index fingertips','Look a little bashful','Hold your shy smile'],
  ['shared-heart','Shared Heart',2,2,'half','Stand close together','Make half a heart each','Join hands in the middle','Smile through your heart'],
  ['overhead-heart','Overhead Heart',2,2,'full','Stand side by side','Raise your outer arms','Curve them into one heart','Hold your big heart'],
  ['heart-rejection','Heart + Rejection',2,2,'half','One offers a hand heart','The other folds their arms','Add a deadpan stare','Hold the playful rejection'],
  ['spider-point','Spider-Man Pointing',3,4,'half','Face your friends','Point at one another','Look very surprised','Hold the pointing circle'],
  ['distracted-trio','Distracted Trio',3,3,'full','Two stand together','One looks at the third friend','Their partner looks shocked','Freeze the distraction'],
  ['is-this-pigeon','Is This a Pigeon?',2,2,'half','One presents an open palm','The other gestures toward it','Look completely confused','Hold the question'],
  ['cool-chaotic','Cool Friend / Chaotic Friend',2,2,'half','Stand side by side','One stays perfectly cool','The other makes a wild face','Hold both reactions'],
  ['back-to-back-agents','Back-to-Back Agents',2,2,'full','Stand back to back','Fold your arms','Look in opposite directions','Hold your spy stare'],
  ['album-cover','Imaginary Album Cover',4,5,'full','Stand at different depths','Choose different head angles','Keep serious faces','Hold your album cover'],
  ['sunglasses-reveal','Sunglasses Reveal',2,8,'half','Touch your sunglasses','Lower them just a little','Look over the frames','Hold your cool reveal'],
  ['siuuu','Siuuu Freeze',1,8,'full','Plant your feet wide','Arms down and outward','Lift your chin','Hold your victory pose'],
  ['dab','Dab Throwback',3,8,'half','Bend one elbow','Hide your face in it','Reach the other arm diagonally','Freeze your dab'],
  ['jojo','JoJo Dramatic Pose',1,4,'full','Bend one knee','Twist your shoulders slightly','Frame your face with one hand','Hold the dramatic pose'],
  ['ginyu-force','Ginyu Force Formation',5,5,'full','Spread into five spots','Choose different levels','Strike big superhero shapes','Hold the team formation'],
  ['npc-lineup','NPC Lineup',4,8,'full','Stand evenly spaced','Keep your arms stiff','Give a blank expression','Hold the robot lineup'],
  ['buffering','Loading / Buffering',2,8,'half','Start a small gesture','Stop halfway through','Stare completely blankly','Hold while you buffer'],
  ['one-brain-cell','One Brain Cell',4,6,'half','Choose one friend','Everyone else points to them','They look completely confused','Hold the last brain cell'],
  ['bodyguards','Bodyguard Squad',5,7,'full','One star takes the middle','Everyone else folds their arms','Star smiles, guards stay serious','Hold your celebrity squad'],
  ['peekaboo-stack','Peekaboo Stack',4,6,'half','Line up behind each other','Peek out on alternating sides','Keep every face visible','Hold your peekaboo smiles'],
  ['reaction-mix','Everyone Has a Different Reaction',6,8,'half','Gather close together','Each choose a different reaction','Shock, suspicion, joy or confusion','Freeze every funny face']
];
const colors = ['#ff168f','#1769ff','#ffd21a','#8c40ff','#ff8214','#14bda8'];
const cast = [
  'one East Asian young adult woman', 'four adult friends, two men and two women, East Asian and white',
  'one white young adult man wearing sunglasses', 'two adult women, one East Asian and one white',
  'four adult friends, two men and two women, one Black, one white and two East Asian',
  'one East Asian adult man', 'one white adult woman', 'two adult men, East Asian and white',
  'one East Asian adult woman', 'one white adult man', 'one East Asian adult woman',
  'two adult men, East Asian and white', 'two adult women, East Asian and white',
  'one white adult man', 'two adult women, East Asian and white',
  'three adult friends, two men and one woman, East Asian and white', 'two adult men, East Asian and white',
  'three adult women, one Black, one East Asian and one white', 'two adult friends, one man and one woman, East Asian and white',
  'one East Asian adult man', 'two adult women, East Asian and white', 'two adult men, East Asian and white',
  'two adult friends, one man and one woman, East Asian and white', 'three adult friends, two men and one woman, East Asian and white',
  'three adult friends, two women and one man, East Asian and white', 'two adult men, East Asian and white',
  'two adult women, East Asian and white', 'two adult friends, one man and one woman, East Asian and white',
  'four adult friends, two men and two women, one Black, one white and two East Asian',
  'two adult women wearing sunglasses, East Asian and white', 'one East Asian adult man',
  'three adult friends, two men and one woman, East Asian and white', 'one white adult woman',
  'five adult friends, three women and two men, East Asian and white',
  'four adult men, one Black, one white and two East Asian', 'two adult women, East Asian and white',
  'four adult friends, two men and two women, East Asian and white',
  'five adult friends, three women and two men, East Asian and white',
  'four adult women, East Asian and white',
  'six adult friends, three men and three women, one Black, two white and three East Asian'
];
const descriptions = [
  'Both open palms face up at chest height, one hand visibly higher than the other, as if weighing choices; playful confused face.',
  'Four friends in a row with both palms facing up, alternating high and low hands across the row.',
  'Sunglasses, confident relaxed full-body stance, one hand near chest and the other extended loosely in a stylish dance freeze.',
  'Two friends face one another in contrasting dramatic confident poses with serious faces; turn enough for both faces to be visible.',
  'One person confidently in front, three friends behind them with exaggerated impressed expressions and gestures.',
  'Slight side angle, index finger pointing along own jawline, exaggerated serious expression.',
  'One eyebrow raised, lips slightly pursed into a tiny smug smirk, intense camera stare.',
  'Heads mostly facing forward, eyes sharply sideways, suspicious expressions.',
  'One eyebrow visibly raised with an exaggerated suspicious facial expression.',
  'Both open hands beside head with palms toward camera, dramatically impressed expression.',
  'Thumb and index finger crossed into a small finger heart beside face; warm smile.',
  'Each person holds a crossed-thumb-and-index finger heart beside each cheek, two tiny hearts per person.',
  'Inverted V peace sign reaching toward camera, fingers angled down, playful smile.',
  'One hand forms a curved half-heart against own cheek, sweet smile.',
  'Two open palms beneath own chin like flower petals, cheerful tilted heads.',
  'Hands curled like cat paws beside cheeks, heads tilted playfully.',
  'One index finger touching own cheek, smiling or pouting.',
  'Two V peace signs beside eyes, each person winking playfully.',
  'Finger circles around both eyes as pretend goggles, silly wide-eyed expression.',
  'Index fingertips touching at chest height, shoulders gently tucked, bashful smile.',
  'Each partner forms one half of the same hand heart, hands joined between them, happy smiles.',
  'Side by side with outer arms curved overhead to form one large shared heart; full bodies visible.',
  'One offers a hand heart toward the other, who folds their arms with a humorous deadpan expression.',
  'Three friends point at each other in a triangle, surprised expressions, all faces visible; ordinary clothes, no costumes.',
  'Three-person scene: two companions together, one turns to admire third friend while their companion looks shocked; playful, all faces visible.',
  'One friend presents an empty open palm as an imaginary object; the other gestures toward it with exaggerated confusion.',
  'One friend perfectly composed and cool; the other beside them makes an outrageous wide-eyed open-mouth face.',
  'Back to back, arms folded, looking in opposite directions; both faces visible in three-quarter profile.',
  'Friends at staggered depths with contrasting head angles and serious faces, a stylish imaginary band album portrait.',
  'Each person lowers their sunglasses slightly with one hand and peers over the frames with a confident stare.',
  'Feet planted wide, arms straight down and outward, chest lifted and chin raised in a triumphant celebration.',
  'Each person hides face in a bent elbow while extending the opposite arm diagonally; recognizable dab.',
  'One knee bent, torso slightly twisted, one hand framing face, theatrical expressive pose; ordinary clothes.',
  'Five friends in a balanced formation at different standing and crouching levels, exaggerated different superhero arm shapes; no costumes.',
  'Four people in an evenly spaced row with identical blank faces, straight stiff arms at sides.',
  'Freeze with one hand halfway through a small gesture, vacant eyes and blank expression as if buffering.',
  'Three friends point to the fourth in the center, who looks completely confused.',
  'One smiling celebrity in center, four serious arms-crossed bodyguards arranged around them.',
  'Four friends in a compact vertical-depth stack, peeking alternately left and right; all four faces clearly visible.',
  'Six friends tightly grouped, each with a distinct shocked, suspicious, smug, mock-crying, confused or delighted facial expression.'
];
if (rows.length !== 40 || cast.length !== 40 || descriptions.length !== 40) throw new Error('Meme pack must contain all 40 poses');
const poses = rows.map(([slug,name,people,max,framing,...cues], index) => {
  const id = `meme-${slug}`;
  const styles = people === 1 ? (max === 1 ? ['solo'] : ['solo','couple','friends','family','group'])
    : people === 2 ? ['couple','friends','family','group'] : ['friends','family','group'];
  const scene = {
    schemaVersion: 2, id, name, category: people === 1 ? 'solo' : people === 2 ? 'friends' : 'group',
    tags: ['meme-pack-2026', 'gender-inclusive', 'child-safe', people === 1 ? 'solo' : 'cooperative'],
    instruction: cues.at(-1),
    compatibility: { minPeople: people === 4 && slug === 'six-seven-wave' ? 3 : (['main-character','album-cover','npc-lineup','one-brain-cell','peekaboo-stack'].includes(slug) ? 3 : (slug === 'reaction-mix' ? 4 : people)), maxPeople: max, styles, framing: framing === 'full' ? ['full'] : ['full','half'], childSafe: true },
    roles: Array.from({length: people === 4 && ['six-seven-wave','main-character','album-cover','npc-lineup','one-brain-cell','peekaboo-stack'].includes(slug) ? 3 : slug === 'reaction-mix' ? 4 : people}, () => ({role:'any', repeatable: max > people})),
    animation: { durationMs: 7000, captions: cues.map((text,i) => ({timeMs:i*500,text})) }
  };
  // Repetition is necessary whenever minimum < maximum, including representative groups.
  scene.roles.at(-1).repeatable = scene.compatibility.minPeople < max;
  const title = name === '6–7 Hands' ? '6–7' : name.replace(' + ', ' & ').replace(' / ', ' & ').toUpperCase();
  const prompt = `Use case: photorealistic-natural. Create ONE photo booth pose-guide sticker. Match reference for photorealistic people, thick white sticker border, thin colorful neon outline and bold colorful dimensional arcade title. Exactly ${people} people: ${cast[index]}. Pose: ${descriptions[index]} Show one static final pose, never a sequence or collage. ${framing === 'full' ? 'Full bodies, every foot visible.' : 'Waist-up framing, all heads and hands visible.'} Eye-level straight-on studio portrait. Natural anatomy and accurate hands. Contemporary colorful casual clothing. Integrate the exact title "${title}" beneath the people without obscuring hands or faces. Genuine transparent background with clear empty space, no glow backdrop, no scenery, no floor, no panel, no additional text, no watermark. ${['aura-farmer','sunglasses-reveal'].includes(slug) ? 'Sunglasses are required for this pose.' : 'Empty hands, no props or sunglasses.'}`;
  return { scene, people, title, description: descriptions[index], accent: colors[index % colors.length], assetPath:`pose-guides/${id}.webp`, prompt };
});
module.exports = poses;
