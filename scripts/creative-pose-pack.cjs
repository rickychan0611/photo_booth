function pose({ audience, category, styles, framing, childSafe, roles, id, name, mood, cues, flexible = false, tags = [] }) {
  if (cues.length !== 4) throw new Error(`${id} needs 4 cues`);
  return {
    schemaVersion: 2,
    id: `${audience}-${framing}-${id}`,
    name,
    category,
    tags: ['creative-pack', 'four-second', `audience-${audience}`, `framing-${framing}`, `mood-${mood}`, childSafe ? 'child-safe' : 'adult-only', 'cooperative', ...tags],
    instruction: cues.at(-1),
    animation: { durationMs: 4000, captions: [{ timeMs: 0, text: 'Find your mark' }, ...cues.map((text, index) => ({ timeMs: (index + 1) * 500, text }))] },
    compatibility: { minPeople: flexible ? 5 : roles.length, maxPeople: flexible ? null : roles.length, styles, framing: [framing], childSafe },
    roles: roles.map((role, index) => ({ role, repeatable: flexible && index === roles.length - 1 }))
  };
}

function batch(common, rows) {
  return rows.map(([id, name, mood, ...cues]) => pose({ ...common, id, name, mood, cues }));
}

const lovers = (framing, rows) => batch({ audience: 'lovers', category: 'couple', styles: ['couple'], framing, childSafe: false, roles: ['adult', 'adult'] }, rows);
const friends = (audience, count, role, framing, rows) => batch({ audience, category: 'friends', styles: ['friends'], framing, childSafe: true, roles: Array(count).fill(role) }, rows);
const family = (audience, framing, childSafe, roles, rows, tags) => batch({ audience, category: 'family', styles: ['family'], framing, childSafe, roles, tags }, rows);
const crowd = (framing, rows) => batch({ audience: 'group-5', category: 'group', styles: ['group', 'friends', 'family'], framing, childSafe: true, roles: ['any', 'any', 'any', 'any', 'any'], flexible: true }, rows);

const scenes = [
  ...lovers('full', [
    ['slow-dance', 'Slow Dance', 'sweet', 'Offer one hand', 'Step in together', 'Sway on the spot', 'Rest your heads'],
    ['forehead-promise', 'Forehead Promise', 'sweet', 'Stand toe to toe', 'Hold both hands', 'Lean in gently', 'Touch foreheads'],
    ['cheek-sway', 'Cheek Sway', 'cute', 'Stand side by side', 'Wrap an arm around', 'Sway once', 'Cheek to cheek'],
    ['ballroom-dip', 'Ballroom Dip', 'cool', 'Take a dance hold', 'Step one foot wide', 'Dip your partner', 'Smile up at them'],
    ['spy-lean', 'Spy Lean', 'cool', 'Stand back to back', 'Look over one shoulder', 'Cross one ankle', 'Smirk together'],
    ['proposal-gasp', 'Proposal Gasp', 'funny', 'One of you kneels', 'The other covers their mouth', 'Hands to your cheeks', 'Freeze the big yes'],
    ['lift-laugh', 'Lift Laugh', 'funny', 'Count down together', 'Jump into a small lift', 'Kick one foot up', 'Laugh at the camera'],
    ['spin-catch', 'Spin Catch', 'crazy', 'Start two steps apart', 'Spin toward each other', 'Catch hands and stop', 'Freeze mid-laugh'],
    ['mirror-walk', 'Mirror Walk', 'challenge', 'Walk in the same step', 'Match your arm swing', 'Hit the same pose', 'Hold the mirror'],
    ['trust-lean', 'Trust Lean', 'challenge', 'Face each other', 'Hold both hands tight', 'Lean back together', 'Balance and smile']
  ]),
  ...lovers('half', [
    ['nose-boop', 'Nose Boop', 'cute', 'Lean in close', 'Wrinkle your noses', 'Boop once', 'Giggle and hold'],
    ['almost-kiss', 'Almost Kiss', 'sweet', 'Tilt toward each other', 'Close your eyes', 'Stop just before a kiss', 'Smile without moving'],
    ['shared-secret', 'Shared Secret', 'sweet', 'Bring your heads together', 'One whispers', 'The other melts', 'Share the smile'],
    ['heart-hands', 'Heart Hands', 'cute', 'Lift your hands', 'Make half a heart each', 'Join them in the middle', 'Peek through and smile'],
    ['chin-lift', 'Chin Lift', 'cool', 'One hand under the chin', 'Lift it just a little', 'Look into the lens', 'Hold the movie stare'],
    ['matching-smirk', 'Matching Smirk', 'cool', 'Same head tilt', 'One eyebrow up', 'Match the smirk', 'Do not blink'],
    ['proposal-face', 'Proposal Face', 'funny', 'One looks hopeful', 'The other looks shocked', 'Hands on cheeks', 'Burst into a grin'],
    ['drama-gasp', 'Drama Gasp', 'crazy', 'Clutch each other', 'Gasp at the same time', 'Eyes wide', 'Freeze the melodrama'],
    ['cheek-press', 'Cheek Press', 'sweet', 'Press cheeks together', 'Close your eyes', 'Soft little smiles', 'Stay right there'],
    ['sync-wink', 'Sync Wink', 'challenge', 'Same smile first', 'Count silently', 'Wink the same eye', 'Hold the wink']
  ]),
  ...friends('women-2', 2, 'women', 'full', [
    ['pinky-jump', 'Pinky Jump', 'cute', 'Lock pinkies', 'Bend your knees', 'Jump together', 'Land still smiling'],
    ['hand-heart-walk', 'Hand Heart Walk', 'sweet', 'Walk toward the camera', 'Swing your joined hands', 'Make a heart', 'Stop cheek to cheek'],
    ['lean-on-me', 'Lean on Me', 'sweet', 'Stand shoulder to shoulder', 'One leans her head', 'The other steadies her', 'Soft smiles'],
    ['shopping-strut', 'Shopping Strut', 'cool', 'One foot in front', 'Hands on hips', 'Strut two steps', 'Hit a cover pose'],
    ['spy-sisters', 'Spy Sisters', 'cool', 'Back to back', 'Look over opposite shoulders', 'Cross one leg', 'Cool half-smile'],
    ['piggyback-giggle', 'Piggyback Giggle', 'funny', 'One hops on', 'Hold on tight', 'Kick your feet', 'Laugh at the lens'],
    ['runway-tug', 'Runway Tug', 'funny', 'One tries to walk off', 'The other tugs her back', 'Both stumble into pose', 'Point at the camera'],
    ['bestie-dip', 'Bestie Dip', 'crazy', 'Take a dance hold', 'Dip dramatically', 'Free arm in the air', 'Freeze the laugh'],
    ['sync-kick', 'Sync Kick', 'challenge', 'Stand side by side', 'Arms linked', 'Kick the same leg', 'Hold it up'],
    ['freeze-five', 'Freeze Five', 'challenge', 'Run at each other', 'Jump into a high five', 'Stop exactly there', 'Hold the slap']
  ]),
  ...friends('women-2', 2, 'women', 'half', [
    ['cheek-squish', 'Cheek Squish', 'cute', 'Squish your cheeks in', 'Touch noses', 'Big sparkling eyes', 'Hold the cute face'],
    ['heart-cheeks', 'Heart Cheeks', 'sweet', 'Hands under your chins', 'Tilt together', 'Soft eye contact', 'Stay sweet'],
    ['chin-on-shoulder', 'Chin on Shoulder', 'sweet', 'One rests her chin', 'The other leans in', 'Match the smile', 'Do not look away'],
    ['sunglasses-drop', 'Sunglasses Drop', 'cool', 'Start with glasses on', 'Drop them together', 'One eyebrow up', 'Hold the reveal'],
    ['hair-flip-duo', 'Hair Flip Duo', 'cool', 'Look down', 'Flip your hair', 'Snap up to the lens', 'Cool stare'],
    ['whisper-gasp', 'Whisper Gasp', 'funny', 'One cups a hand', 'Whisper one word', 'The other gasps', 'Freeze the shock'],
    ['boop-battle', 'Boop Battle', 'funny', 'Boop her nose', 'She boops back', 'Both wrinkle your noses', 'Laugh and hold'],
    ['evil-grin', 'Evil Grin', 'crazy', 'Lean in like a plot', 'Steeple your fingers', 'Slow wicked grin', 'Hold the scheme'],
    ['matching-peace', 'Matching Peace', 'cute', 'Peace signs up', 'Tilt opposite ways', 'Same smile', 'Hold the pair'],
    ['wink-sync', 'Wink Sync', 'challenge', 'Same head angle', 'Count to three', 'Wink together', 'Keep the smile']
  ]),
  ...friends('women-3', 3, 'women', 'full', [
    ['group-hug-jump', 'Group Hug Jump', 'cute', 'Squeeze into a hug', 'Bend your knees', 'Little jump together', 'Land in the hug'],
    ['friendship-lift', 'Friendship Lift', 'sweet', 'Middle friend steps in', 'The others support her', 'One foot pops up', 'All three smile'],
    ['triangle-power', 'Triangle Power', 'cool', 'One steps forward', 'Two angle behind', 'Hands on hips', 'Power stare'],
    ['linked-strut', 'Linked Strut', 'cool', 'Link elbows', 'Walk three steps', 'Stop in a line', 'Chin up'],
    ['silly-walk', 'Silly Walk', 'funny', 'Each pick a silly step', 'March toward the camera', 'Stop at the same time', 'Hold the nonsense'],
    ['super-landing', 'Super Landing', 'funny', 'Crouch low', 'One arm back', 'Pop up into heroes', 'Freeze the landing'],
    ['spin-out', 'Spin Out', 'crazy', 'Hold hands in a circle', 'Spin once', 'Break toward the camera', 'Freeze mid-turn'],
    ['piggy-chain', 'Piggy Chain', 'crazy', 'Stack a playful lean', 'Arms out for balance', 'Everyone makes a face', 'Hold the tower'],
    ['kickline', 'Kickline', 'challenge', 'Shoulder to shoulder', 'Arms around waists', 'Kick in unison', 'Hold the kick'],
    ['statue-challenge', 'Statue Challenge', 'challenge', 'Strike three different statues', 'Do not wobble', 'Eyes on the lens', 'Hold perfectly still']
  ]),
  ...friends('women-3', 3, 'women', 'half', [
    ['stacked-chins', 'Stacked Chins', 'cute', 'Lean in a staircase', 'Chins almost touching', 'Bright eyes', 'Hold the stack'],
    ['three-hearts', 'Three Hearts', 'sweet', 'Each make a tiny heart', 'Bring them together', 'Peek over your hands', 'Soft smiles'],
    ['cheek-row', 'Cheek Row', 'sweet', 'Press cheek to cheek', 'Middle friend centers it', 'Close your eyes', 'Stay in the row'],
    ['glam-angles', 'Glam Angles', 'cool', 'Sharp chin angles', 'One hand in your hair', 'Look down the lens', 'Hold the editorial'],
    ['frame-the-middle', 'Frame the Middle', 'cool', 'Outside friends frame her face', 'Middle friend poses', 'Everyone looks through', 'Hold the frame'],
    ['whisper-chain', 'Whisper Chain', 'funny', 'Whisper to the next friend', 'Pass it down the line', 'Last friend loses it', 'Freeze the laugh'],
    ['shocked-trio', 'Shocked Trio', 'funny', 'Same gasp', 'Hands on cheeks', 'Eyes huge', 'Hold the shock'],
    ['villain-trio', 'Villain Trio', 'crazy', 'Lean in like a council', 'One brow up each', 'Slow evil smile', 'Hold the plot'],
    ['peace-crown', 'Peace Crown', 'cute', 'Peace signs around one face', 'Middle friend shines', 'Tilt together', 'Hold the crown'],
    ['blink-together', 'Blink Together', 'challenge', 'Same smile', 'Same head height', 'Blink on one count', 'Reopen together']
  ]),
  ...friends('women-4', 4, 'women', 'full', [
    ['flower-hug', 'Flower Hug', 'sweet', 'Step into one hug', 'Outside friends wrap in', 'Squeeze once', 'Smile in the bloom'],
    ['promenade', 'Promenade', 'sweet', 'Walk in pairs', 'Swing your arms', 'Arrive in a line', 'Hold the stroll'],
    ['diamond-strut', 'Diamond Strut', 'cool', 'One leads', 'Two flank her', 'One closes the back', 'Hit the diamond'],
    ['action-line', 'Action Line', 'cool', 'Stagger your heights', 'One arm forward each', 'Lean into the shot', 'Hold the poster'],
    ['buddy-carry', 'Buddy Carry', 'funny', 'Pair up', 'Playful lifts or leans', 'Kick a free foot', 'Laugh and freeze'],
    ['puppy-pile', 'Puppy Pile', 'funny', 'Kneel and lean in', 'Stack the hug low', 'Everyone makes a face', 'Hold the pile'],
    ['cheer-jump', 'Cheer Jump', 'crazy', 'Arms up', 'Count to three', 'Jump at once', 'Land in a cheer'],
    ['square-heroes', 'Square Heroes', 'crazy', 'Four low stances', 'Different arm shapes', 'Pop tall together', 'Freeze the team'],
    ['kick-sync', 'Kick Sync', 'challenge', 'Link arms', 'Same leg ready', 'Kick on one count', 'Hold the line'],
    ['mirror-squad', 'Mirror Squad', 'challenge', 'Copy the leader', 'Same hands', 'Same foot', 'Hold the copy']
  ]),
  ...friends('women-4', 4, 'women', 'half', [
    ['four-faces', 'Four Faces', 'cute', 'Pack in close', 'Chins level', 'Bright matching eyes', 'Hold the bouquet'],
    ['cheek-train', 'Cheek Train', 'sweet', 'Cheek to cheek across', 'Tilt the same way', 'Soft smiles', 'Stay tucked in'],
    ['heart-frame', 'Heart Frame', 'sweet', 'Outside hands make a heart', 'Inside friends pose inside it', 'Everyone looks through', 'Hold the heart'],
    ['sunglasses-wall', 'Sunglasses Wall', 'cool', 'Glasses on', 'Lower them together', 'One cool stare', 'Hold the wall'],
    ['lean-in-row', 'Lean-In Row', 'cool', 'Lean from alternating sides', 'Shoulders overlap', 'Chins sharp', 'Hold the stack'],
    ['gossip-circle', 'Gossip Circle', 'funny', 'Heads in a huddle', 'One spills the secret', 'Three react differently', 'Freeze the gossip'],
    ['gasp-wave', 'Gasp Wave', 'funny', 'Gasp from left to right', 'Hands to cheeks', 'Last friend points', 'Hold the wave'],
    ['expression-parade', 'Expression Parade', 'crazy', 'Cute, cool, shocked, unhinged', 'Switch on one count', 'New face each', 'Freeze the wildest'],
    ['peace-stack', 'Peace Stack', 'cute', 'Four peace signs', 'Stack them high', 'Smile under them', 'Hold the stack'],
    ['pose-on-beat', 'Pose on the Beat', 'challenge', 'Hands down', 'Hit pose one', 'Hit pose two', 'Freeze together']
  ]),
  ...friends('men-2', 2, 'men', 'full', [
    ['bro-pull', 'Bro Pull', 'funny', 'Clasp hands', 'Yank into a lean', 'One foot up', 'Freeze the stumble'],
    ['shoulder-ride-joke', 'Shoulder Ride Joke', 'funny', 'One crouches', 'The other sits tall', 'Both point forward', 'Hold the joke'],
    ['back-to-back-cool', 'Back-to-Back Cool', 'cool', 'Stand back to back', 'Arms folded', 'Look off to the sides', 'Hold the poster'],
    ['victory-jump', 'Victory Jump', 'crazy', 'Wind up', 'Jump with fists up', 'Shout the win', 'Land and hold'],
    ['trust-catch', 'Trust Catch', 'challenge', 'One leans back', 'The other catches', 'Stop before the fall', 'Hold the trust']
  ]),
  ...friends('men-2', 2, 'men', 'half', [
    ['secret-handshake-face', 'Secret Handshake Face', 'funny', 'Start the handshake', 'Lose the choreography', 'Blame each other', 'Laugh and hold'],
    ['arm-around-grin', 'Arm Around Grin', 'sweet', 'Arm across his shoulder', 'Knock your heads once', 'Big easy grins', 'Stay there'],
    ['matching-smirk', 'Matching Smirk', 'cool', 'Same tilt', 'Same squint', 'Same smirk', 'Do not break'],
    ['double-point', 'Double Point', 'crazy', 'Point at the lens', 'Lean in hard', 'Eyebrows up', 'Hold the accusation'],
    ['fist-bump-freeze', 'Fist Bump Freeze', 'challenge', 'Raise your fists', 'Meet in the middle', 'Stop on contact', 'Hold the bump']
  ]),
  ...friends('men-3', 3, 'men', 'full', [
    ['comedy-chase', 'Comedy Chase', 'funny', 'One runs ahead', 'Two reach to grab him', 'Everyone looks back', 'Freeze the chase'],
    ['huddle-break', 'Huddle Break', 'funny', 'Huddle tight', 'Hands in', 'Break toward the camera', 'Hold the shout'],
    ['squad-stance', 'Squad Stance', 'cool', 'Wide feet', 'Arms crossed or in pockets', 'Stagger the line', 'Cool stare'],
    ['lift-the-middle', 'Lift the Middle', 'crazy', 'Middle friend hops', 'Two friends support him', 'One fist up', 'Hold the lift'],
    ['sync-jump', 'Sync Jump', 'challenge', 'Line up', 'Bend together', 'Jump on one count', 'Land in the same pose']
  ]),
  ...friends('men-3', 3, 'men', 'half', [
    ['whisper-lose-it', 'Whisper and Lose It', 'funny', 'One whispers', 'Second cracks', 'Third is already gone', 'Hold the mess'],
    ['stacked-peace', 'Stacked Peace', 'cute', 'Three peace signs', 'Stack them in front', 'Cheesy grins', 'Hold the stack'],
    ['three-smirks', 'Three Smirks', 'cool', 'Lean in a triangle', 'Same smirk', 'Eyes on the lens', 'Hold it'],
    ['serious-then-burst', 'Serious Then Burst', 'crazy', 'Start stone faced', 'Hold one beat', 'Explode into laughs', 'Freeze the burst'],
    ['chin-up-trio', 'Chin-Up Trio', 'challenge', 'Same chin height', 'Same stare', 'No smiling yet', 'Hold, then one smile']
  ]),
  ...family('family-3', 'full', true, ['adult', 'adult', 'child'], [
    ['parent-swing', 'Parent Swing', 'cute', 'Child holds both hands', 'Grownups lift gently', 'Swing once', 'Smile at the child'],
    ['little-leader', 'Little Leader', 'sweet', 'Child steps in front', 'Grownups kneel behind', 'Follow the kid\'s pose', 'Hold the little boss']
  ], ['with-kids']),
  ...family('family-3', 'full', true, ['adult', 'child', 'child'], [
    ['airplane-kids', 'Airplane Kids', 'crazy', 'Grownup plants their feet', 'Kids stretch out like wings', 'One foot pops', 'Hold the flight'],
    ['family-jump', 'Family Jump', 'funny', 'Hold hands', 'Crouch together', 'Small jump', 'Land laughing']
  ], ['with-kids']),
  ...family('family-3', 'full', false, ['adult', 'adult', 'adult'], [
    ['family-stroll', 'Family Stroll', 'sweet', 'Walk arm in arm', 'Match your steps', 'Stop in a line', 'Easy smiles'],
    ['generation-pose', 'Generation Pose', 'cool', 'Stagger your height', 'Hands in pockets or on hips', 'Look just off camera', 'Hold the portrait'],
    ['kitchen-dance', 'Kitchen Dance', 'funny', 'Someone starts dancing', 'The others join badly', 'One big spin', 'Freeze the chaos']
  ]),
  ...family('family-3', 'half', true, ['adult', 'adult', 'child'], [
    ['cheek-kisses', 'Cheek Kisses', 'sweet', 'Lean into the child', 'Kiss a cheek each', 'Child beams', 'Hold the kisses'],
    ['piggy-chin', 'Piggy Chin', 'cute', 'Child in the middle', 'Grownups rest chins close', 'All scrunch noses', 'Hold the pile']
  ], ['with-kids']),
  ...family('family-3', 'half', true, ['adult', 'child', 'child'], [
    ['silly-faces-kid', 'Silly Faces', 'funny', 'Kids pick the faces', 'Grownup copies them', 'Worse is better', 'Freeze the silliest'],
    ['tiny-hero', 'Tiny Hero', 'cool', 'Child centers the frame', 'Grownup frames them', 'Hero hands on hips', 'Hold the star']
  ], ['with-kids']),
  ...family('family-3', 'half', false, ['adult', 'adult', 'adult'], [
    ['three-smiles', 'Three Smiles', 'sweet', 'Heads together', 'Soft matching smiles', 'Eyes kind', 'Hold the warmth'],
    ['storytime-laugh', 'Storytime Laugh', 'funny', 'One tells a tiny story', 'The others break', 'Hands over mouths', 'Hold the laugh'],
    ['matching-lean', 'Matching Lean', 'cool', 'Same shoulder angle', 'Same calm face', 'Look into the lens', 'Hold the lean']
  ]),
  ...family('family-4', 'full', true, ['adult', 'adult', 'child', 'child'], [
    ['parents-and-pair', 'Parents and Pair', 'sweet', 'Kids in front', 'Grownups behind', 'Hands on shoulders', 'One family smile'],
    ['hoist-the-kids', 'Hoist the Kids', 'crazy', 'Grownups get steady', 'Kids hop up for a hold', 'Arms out', 'Hold the lift']
  ], ['with-kids']),
  ...family('family-4', 'full', true, ['adult', 'adult', 'adult', 'child'], [
    ['one-kid-star', 'One Kid Star', 'cute', 'Child takes the front', 'Three grownups fan behind', 'Copy the kid\'s hands', 'Hold the star']
  ], ['with-kids']),
  ...family('family-4', 'full', true, ['adult', 'child', 'child', 'child'], [
    ['kid-pile', 'Kid Pile', 'funny', 'Kids pile into a hug', 'Grownup anchors them', 'Everyone makes a face', 'Hold the pile']
  ], ['with-kids']),
  ...family('family-4', 'full', false, ['adult', 'adult', 'adult', 'adult'], [
    ['four-across', 'Four Across', 'cool', 'Stand shoulder to shoulder', 'Mix pockets and folded arms', 'Stagger one foot', 'Hold the line'],
    ['portrait-walk', 'Portrait Walk', 'sweet', 'Walk toward the camera', 'Arms loosely linked', 'Stop in a row', 'Warm smiles'],
    ['reunion-jump', 'Reunion Jump', 'funny', 'Count together', 'Jump like you just arrived', 'Arms up', 'Land laughing']
  ]),
  ...family('family-4', 'half', true, ['adult', 'adult', 'child', 'child'], [
    ['sandwich-hug', 'Sandwich Hug', 'sweet', 'Kids in the middle', 'Grownups wrap in', 'Cheeks touching', 'Hold the sandwich'],
    ['four-silly-faces', 'Four Silly Faces', 'funny', 'Each pick a face', 'Show them together', 'Kids may go wilder', 'Freeze the set']
  ], ['with-kids']),
  ...family('family-4', 'half', true, ['adult', 'adult', 'adult', 'child'], [
    ['kid-whisper', 'Kid Whisper', 'cute', 'Child whispers to one grownup', 'That face changes', 'The others lean in', 'Hold the secret']
  ], ['with-kids']),
  ...family('family-4', 'half', true, ['adult', 'child', 'child', 'child'], [
    ['crown-the-kid', 'Crown the Kid', 'cool', 'Kids make a crown with hands', 'One child wears it', 'Grownup steadies the pose', 'Hold the crown']
  ], ['with-kids']),
  ...family('family-4', 'half', false, ['adult', 'adult', 'adult', 'adult'], [
    ['close-portrait', 'Close Portrait', 'sweet', 'Pack in tight', 'Heads touching', 'Kind eyes', 'Hold the portrait'],
    ['laugh-line', 'Laugh Line', 'funny', 'One starts laughing', 'Pass it down the row', 'Last person breaks', 'Hold the line'],
    ['cool-generations', 'Cool Generations', 'cool', 'Same lean', 'Mix smiles and smirks', 'Look just past the lens', 'Hold the cool']
  ]),
  ...crowd('full', [
    ['stadium-jump', 'Stadium Jump', 'crazy', 'Pack into two rows', 'Bend your knees', 'Jump on three', 'Land with arms up'],
    ['star-burst', 'Star Burst', 'crazy', 'Cluster tight', 'Burst one step out', 'Arms like a star', 'Hold the burst'],
    ['conga-freeze', 'Conga Freeze', 'funny', 'Hands on the shoulders ahead', 'Two silly steps', 'Stop in the line', 'Look back and grin'],
    ['surprise-pop', 'Surprise Pop', 'funny', 'Crouch below the frame', 'Wait one beat', 'Pop up together', 'Hold the surprise'],
    ['wave-rows', 'Wave Rows', 'cute', 'Back row starts the wave', 'Front row follows', 'Hands high', 'Hold the crest'],
    ['circle-hands', 'Circle of Hands', 'sweet', 'Make a loose circle', 'Hold your neighbors\' hands', 'Lean in', 'Smile across the circle'],
    ['team-lean', 'Team Lean', 'sweet', 'Front row kneels', 'Back row stands', 'Lean in as one', 'Hold the team'],
    ['red-carpet-line', 'Red Carpet Line', 'cool', 'Stagger a long line', 'One hand on a hip', 'Chin up', 'Hold the arrival'],
    ['superhero-cluster', 'Superhero Cluster', 'cool', 'Mix low and tall stances', 'Different hero arms', 'Eyes fierce or grinning', 'Hold the poster'],
    ['march-in-place', 'March in Place', 'funny', 'Knees up together', 'Two marches', 'Stop mid-step', 'Hold the march'],
    ['laughing-kneel', 'Laughing Kneel', 'funny', 'Front row drops to a knee', 'Back row leans over', 'Everyone cracks up', 'Hold the pile'],
    ['freeze-dance', 'Freeze Dance', 'crazy', 'Dance for one beat', 'Stop wherever you are', 'Do not fix it', 'Hold the accident'],
    ['shoulder-chain', 'Shoulder Chain', 'cool', 'Arm on the next shoulder', 'Lean the same way', 'One cool face', 'Hold the chain'],
    ['portrait-layers', 'Portrait Layers', 'sweet', 'Tallest in the back', 'Shortest in front', 'Hands relaxed', 'One warm portrait'],
    ['countdown-jump', 'Countdown Jump', 'challenge', 'Everyone shows a number on their fingers', 'Drop the hands', 'Jump together', 'Stick the landing'],
    ['letter-shape', 'Letter Shape', 'challenge', 'Make the letter A with your bodies', 'Arms are the peak', 'Feet plant the sides', 'Hold the letter'],
    ['kick-line', 'Kick Line', 'challenge', 'Link elbows', 'Same leg ready', 'Kick once', 'Hold it up'],
    ['level-change', 'Level Change', 'challenge', 'Some stand, some kneel, some crouch', 'No two neighbors match', 'Eyes to the lens', 'Hold the levels'],
    ['victory-roar', 'Victory Roar', 'crazy', 'Fists in', 'Break outward', 'Roar the win', 'Freeze with arms wide'],
    ['buddy-clusters', 'Buddy Clusters', 'cute', 'Split into little pairs', 'Each pair picks a tiny pose', 'Look back at the camera', 'Hold your cluster']
  ]),
  ...crowd('half', [
    ['cheek-pile', 'Cheek Pile', 'cute', 'Pack your faces in', 'Cheeks touching', 'Bright eyes', 'Hold the pile'],
    ['big-shared-heart', 'Big Shared Heart', 'sweet', 'Outside hands start a heart', 'Everyone else tucks inside', 'Look through it', 'Hold the heart'],
    ['lean-in-secret', 'Lean-In Secret', 'sweet', 'Heads into a huddle', 'One shares a look', 'Everyone softens', 'Hold the secret'],
    ['chorus-face', 'Chorus Face', 'sweet', 'Same gentle smile', 'Same head height as you can', 'Eyes kind', 'Hold the chorus'],
    ['sunglasses-squad', 'Sunglasses Squad', 'cool', 'Glasses on', 'Lower them as a group', 'One eyebrow each', 'Hold the squad'],
    ['cool-stare', 'Cool Stare', 'cool', 'Start serious', 'Hold one beat', 'Let one smile slip', 'Hold the mix'],
    ['point-at-center', 'Point at Center', 'cool', 'Center person poses', 'Everyone else points at them', 'Center owns it', 'Hold the spotlight'],
    ['whisper-row', 'Whisper Row', 'funny', 'Pass a whisper across', 'Each face reacts', 'Last person gasps', 'Hold the row'],
    ['expression-countdown', 'Expression Countdown', 'funny', 'Face one', 'Face two', 'Face three', 'Freeze the worst one'],
    ['sync-gasp', 'Sync Gasp', 'funny', 'Hands ready', 'Gasp together', 'Eyes wide', 'Hold the gasp'],
    ['bubble-cheeks', 'Bubble Cheeks', 'cute', 'Puff your cheeks', 'Lean in', 'Try not to laugh', 'Hold the bubbles'],
    ['peace-skyline', 'Peace Skyline', 'cute', 'Peace signs at different heights', 'Pack the faces under them', 'Big smiles', 'Hold the skyline'],
    ['hand-heart-tunnel', 'Hand Heart Tunnel', 'sweet', 'Hands make a tunnel of hearts', 'Faces peek through', 'Find the lens', 'Hold the tunnel'],
    ['wink-wave', 'Wink Wave', 'crazy', 'Wink from one side to the other', 'Keep it moving', 'End on the last wink', 'Hold that face'],
    ['silly-filter', 'Silly Filter', 'crazy', 'Pick the weirdest face you can', 'Show it at once', 'No matching allowed', 'Hold the mess'],
    ['victory-grin', 'Victory Grin', 'crazy', 'Lean in hard', 'Huge grins', 'Someone points up', 'Hold the win'],
    ['matching-tilt', 'Matching Tilt', 'challenge', 'Tilt the same direction', 'Same smile size', 'Same timing', 'Hold the tilt'],
    ['frame-one', 'Frame One', 'challenge', 'Choose one person', 'Everyone else frames their face', 'That person poses', 'Hold the frame'],
    ['blink-on-three', 'Blink on Three', 'challenge', 'Eyes open', 'Count together', 'Blink once', 'Reopen and smile'],
    ['stillness-challenge', 'Stillness Challenge', 'challenge', 'Find a face', 'Hands freeze', 'No wiggling', 'Hold completely still']
  ])
];

const expected = {
  'lovers:full': 10, 'lovers:half': 10,
  'women-2:full': 10, 'women-2:half': 10,
  'women-3:full': 10, 'women-3:half': 10,
  'women-4:full': 10, 'women-4:half': 10,
  'men-2:full': 5, 'men-2:half': 5,
  'men-3:full': 5, 'men-3:half': 5,
  'family-3:full': 7, 'family-3:half': 7,
  'family-4:full': 7, 'family-4:half': 7,
  'group-5:full': 20, 'group-5:half': 20
};
for (const [key, count] of Object.entries(expected)) {
  const [audience, framing] = key.split(':');
  const found = scenes.filter(scene => scene.tags.includes(`audience-${audience}`) && scene.compatibility.framing[0] === framing).length;
  if (found !== count) throw new Error(`${key} has ${found}, expected ${count}`);
}
for (const audience of ['family-3', 'family-4']) {
  for (const framing of ['full', 'half']) {
    const kids = scenes.filter(scene => scene.tags.includes(`audience-${audience}`) && scene.tags.includes('with-kids') && scene.compatibility.framing[0] === framing).length;
    if (kids !== 4) throw new Error(`${audience} ${framing} kids ${kids}`);
  }
}
const ids = scenes.map(scene => scene.id);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate creative pose id');

module.exports = scenes;
