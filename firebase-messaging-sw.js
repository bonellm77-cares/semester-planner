// © 2026 Annalee Bowers. All rights reserved.
// This code is proprietary and confidential. Unauthorized copying,
// distribution, or use of this file, in whole or in part, is
// strictly prohibited without prior written permission.
//
// This file must live at the ROOT of your site (same folder as index.html),
// not in a subfolder -- that's a Firebase requirement for the service worker's scope.

importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAl7HAlgDsa4DVDpgD4yD7L-gJOhRxEDko",
  authDomain: "semester-planner-91327.firebaseapp.com",
  projectId: "semester-planner-91327",
  storageBucket: "semester-planner-91327.firebasestorage.app",
  messagingSenderId: "996694322796",
  appId: "1:996694322796:web:8a23638f7991ff3b7b7249"
});

const messaging = firebase.messaging();

// Handles a push arriving while the app is closed / in the background
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'Reminder';
  const body = (payload.notification && payload.notification.body) || '';
  self.registration.showNotification(title, {
    body,
    icon: undefined
  });
});
