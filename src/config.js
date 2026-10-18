// Named, not secret.
//
// These identify the Firebase project; they authorise nothing. Anyone can
// read them out of the published app, which is fine: Firestore's security
// rules decide who may fetch what (see firestore.rules), and the sync key
// that decides who can *read* the bytes never goes near Google at all.
export const FIREBASE = {
  projectId: 'cyclelog-e9f33',
  apiKey: 'AIzaSyAKJZhla1XQ7Wp7S5O3ZTDnjPhpkk25mo4',
};
