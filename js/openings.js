/* A compact opening book, keyed by the space-joined SAN sequence.
 * Used for two things: naming the opening, and marking early moves as "Book"
 * so theory does not get scored as if you found it over the board. */

export const OPENING_BOOK = {
  // --- 1. e4 -------------------------------------------------------------
  'e4': "King's Pawn Opening",
  'e4 e5': 'Open Game',
  'e4 e5 Nf3': "King's Knight Opening",
  'e4 e5 Nf3 Nc6': 'Open Game',
  'e4 e5 Nf3 Nc6 Bb5': 'Ruy Lopez',
  'e4 e5 Nf3 Nc6 Bb5 a6': 'Ruy Lopez: Morphy Defence',
  'e4 e5 Nf3 Nc6 Bb5 a6 Ba4': 'Ruy Lopez: Morphy Defence',
  'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6': 'Ruy Lopez: Closed',
  'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6': 'Ruy Lopez: Exchange Variation',
  'e4 e5 Nf3 Nc6 Bb5 Nf6': 'Ruy Lopez: Berlin Defence',
  'e4 e5 Nf3 Nc6 Bc4': 'Italian Game',
  'e4 e5 Nf3 Nc6 Bc4 Bc5': 'Italian Game: Giuoco Piano',
  'e4 e5 Nf3 Nc6 Bc4 Bc5 b4': 'Evans Gambit',
  'e4 e5 Nf3 Nc6 Bc4 Bc5 c3': 'Italian Game: Giuoco Piano',
  'e4 e5 Nf3 Nc6 Bc4 Nf6': 'Italian Game: Two Knights Defence',
  'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5': 'Two Knights: Knight Attack',
  'e4 e5 Nf3 Nc6 d4': 'Scotch Game',
  'e4 e5 Nf3 Nc6 d4 exd4 Nxd4': 'Scotch Game',
  'e4 e5 Nf3 Nc6 Nc3': 'Three Knights Game',
  'e4 e5 Nf3 Nc6 Nc3 Nf6': 'Four Knights Game',
  'e4 e5 Nf3 Nf6': "Petrov's Defence",
  'e4 e5 Nf3 d6': 'Philidor Defence',
  'e4 e5 Nc3': 'Vienna Game',
  'e4 e5 Bc4': "Bishop's Opening",
  'e4 e5 f4': "King's Gambit",
  'e4 e5 d4': 'Centre Game',

  'e4 c5': 'Sicilian Defence',
  'e4 c5 Nf3': 'Sicilian Defence',
  'e4 c5 Nf3 d6': 'Sicilian Defence',
  'e4 c5 Nf3 d6 d4': 'Sicilian Defence: Open',
  'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3': 'Sicilian Defence: Open',
  'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6': 'Sicilian Defence: Najdorf',
  'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6': 'Sicilian Defence: Dragon',
  'e4 c5 Nf3 d6 Bb5+': 'Sicilian: Moscow Variation',
  'e4 c5 Nf3 Nc6': 'Sicilian Defence',
  'e4 c5 Nf3 Nc6 Bb5': 'Sicilian: Rossolimo',
  'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5': 'Sicilian: Sveshnikov',
  'e4 c5 Nf3 e6': 'Sicilian Defence',
  'e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6': 'Sicilian: Kan Variation',
  'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6': 'Sicilian: Taimanov',
  'e4 c5 Nc3': 'Sicilian Defence: Closed',
  'e4 c5 c3': 'Sicilian Defence: Alapin',
  'e4 c5 d4': 'Sicilian: Smith-Morra Gambit',
  'e4 c5 f4': 'Sicilian: Grand Prix Attack',

  'e4 e6': 'French Defence',
  'e4 e6 d4': 'French Defence',
  'e4 e6 d4 d5': 'French Defence',
  'e4 e6 d4 d5 Nc3': 'French Defence: Paulsen',
  'e4 e6 d4 d5 Nc3 Bb4': 'French Defence: Winawer',
  'e4 e6 d4 d5 Nc3 Nf6': 'French Defence: Classical',
  'e4 e6 d4 d5 Nd2': 'French Defence: Tarrasch',
  'e4 e6 d4 d5 e5': 'French Defence: Advance',
  'e4 e6 d4 d5 exd5': 'French Defence: Exchange',

  'e4 c6': 'Caro-Kann Defence',
  'e4 c6 d4': 'Caro-Kann Defence',
  'e4 c6 d4 d5': 'Caro-Kann Defence',
  'e4 c6 d4 d5 Nc3': 'Caro-Kann: Main Line',
  'e4 c6 d4 d5 Nd2': 'Caro-Kann: Main Line',
  'e4 c6 d4 d5 e5': 'Caro-Kann: Advance',
  'e4 c6 d4 d5 exd5': 'Caro-Kann: Exchange',

  'e4 d5': 'Scandinavian Defence',
  'e4 d5 exd5 Qxd5': 'Scandinavian Defence',
  'e4 d5 exd5 Nf6': 'Scandinavian: Modern Variation',
  'e4 Nf6': "Alekhine's Defence",
  'e4 d6': 'Pirc Defence',
  'e4 d6 d4 Nf6 Nc3 g6': 'Pirc Defence',
  'e4 g6': 'Modern Defence',
  'e4 b6': "Owen's Defence",
  'e4 Nc6': 'Nimzowitsch Defence',

  // --- 1. d4 -------------------------------------------------------------
  'd4': "Queen's Pawn Opening",
  'd4 d5': 'Closed Game',
  'd4 d5 c4': "Queen's Gambit",
  'd4 d5 c4 dxc4': "Queen's Gambit Accepted",
  'd4 d5 c4 e6': "Queen's Gambit Declined",
  'd4 d5 c4 e6 Nc3 Nf6': "Queen's Gambit Declined",
  'd4 d5 c4 e6 Nc3 c6': 'Semi-Slav Defence',
  'd4 d5 c4 c6': 'Slav Defence',
  'd4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4': 'Slav Defence: Main Line',
  'd4 d5 c4 Nc6': 'Chigorin Defence',
  'd4 d5 c4 e5': 'Albin Countergambit',
  'd4 d5 Nf3': "Queen's Pawn Game",
  'd4 d5 Bf4': 'London System',
  'd4 d5 Nf3 Nf6 Bf4': 'London System',
  'd4 d5 Nf3 Nf6 e3': 'Colle System',
  'd4 d5 Nc3': 'Richter-Veresov Attack',

  'd4 Nf6': 'Indian Defence',
  'd4 Nf6 c4': 'Indian Defence',
  'd4 Nf6 c4 e6': 'Indian Defence',
  'd4 Nf6 c4 e6 Nc3 Bb4': 'Nimzo-Indian Defence',
  'd4 Nf6 c4 e6 Nf3 b6': "Queen's Indian Defence",
  'd4 Nf6 c4 e6 g3': 'Catalan Opening',
  'd4 Nf6 c4 g6': 'Indian Defence',
  'd4 Nf6 c4 g6 Nc3 Bg7': "King's Indian Defence",
  'd4 Nf6 c4 g6 Nc3 Bg7 e4': "King's Indian Defence",
  'd4 Nf6 c4 g6 Nc3 d5': 'Grünfeld Defence',
  'd4 Nf6 c4 c5': 'Benoni Defence',
  'd4 Nf6 c4 e5': 'Budapest Gambit',
  'd4 Nf6 Bg5': 'Trompowsky Attack',
  'd4 Nf6 Nf3': 'Indian Defence',
  'd4 Nf6 Nf3 g6 Bf4': 'London System',
  'd4 f5': 'Dutch Defence',
  'd4 e6': "Queen's Pawn Opening",
  'd4 d6': "Queen's Pawn Opening",
  'd4 g6': 'Modern Defence',

  // --- flank openings ----------------------------------------------------
  'c4': 'English Opening',
  'c4 e5': 'English: Reversed Sicilian',
  'c4 c5': 'English: Symmetrical Variation',
  'c4 Nf6': 'English: Anglo-Indian Defence',
  'c4 e6': 'English Opening',
  'c4 g6': 'English Opening',
  'Nf3': 'Réti Opening',
  'Nf3 d5': 'Réti Opening',
  'Nf3 d5 c4': 'Réti Opening',
  'Nf3 Nf6': 'Réti Opening',
  'Nf3 Nf6 c4': 'Réti / English',
  'Nf3 Nf6 g3': "King's Indian Attack",
  'g3': "King's Fianchetto Opening",
  'b3': 'Nimzo-Larsen Attack',
  'f4': "Bird's Opening",
  'b4': 'Polish Opening',
  'Nc3': 'Dunst Opening',
};

/* Longest book line matching the game, as { name, plies }. */
export function identifyOpening(sanList) {
  let best = { name: null, plies: 0 };
  for (let i = 1; i <= Math.min(sanList.length, 16); i++) {
    const key = sanList.slice(0, i).join(' ');
    if (OPENING_BOOK[key]) best = { name: OPENING_BOOK[key], plies: i };
  }
  return best;
}

/* True if the position after ply `n` (1-indexed) is still book. */
export function isBookMove(sanList, n) {
  return Object.prototype.hasOwnProperty.call(
    OPENING_BOOK,
    sanList.slice(0, n).join(' ')
  );
}
