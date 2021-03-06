/**
 * Copyright 2018 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Query } from '../../../src/core/query';
import { doc, orderBy, path } from '../../util/helpers';

import { describeSpec, specTest } from './describe_spec';
import { spec } from './spec_builder';

/** The number of iterations for the benchmark spec tests. */
const STEP_COUNT = 10;

describeSpec(
  `Performance Tests [${STEP_COUNT} iterations]:`,
  ['benchmark'],
  () => {
    specTest('Insert a new document', [], () => {
      let steps = spec().withGCEnabled(false);
      for (let i = 0; i < STEP_COUNT; ++i) {
        steps = steps.userSets(`collection/{i}`, { doc: i }).writeAcks(i);
      }
      return steps;
    });

    specTest(
      'Start a listen, write a document, ack the write, handle watch snapshot, unlisten',
      [],
      () => {
        let currentVersion = 1;
        let steps = spec().withGCEnabled(false);

        for (let i = 0; i < STEP_COUNT; ++i) {
          const query = Query.atPath(path(`collection/${i}`));
          const docLocal = doc(
            `collection/${i}`,
            0,
            { doc: i },
            { hasLocalMutations: true }
          );
          const docRemote = doc(`collection/${i}`, ++currentVersion, {
            doc: i
          });

          steps = steps
            .userListens(query)
            .userSets(`collection/${i}`, { doc: i })
            .expectEvents(query, {
              added: [docLocal],
              fromCache: true,
              hasPendingWrites: true
            })
            .writeAcks(++currentVersion)
            .watchAcksFull(query, ++currentVersion, docRemote)
            .expectEvents(query, { metadata: [docRemote] })
            .userUnlistens(query)
            .watchRemoves(query);
        }
        return steps;
      }
    );

    specTest('Write 100 documents and raise a snapshot', [], () => {
      const cachedDocumentCount = 100;

      const query = Query.atPath(path(`collection`)).addOrderBy(orderBy('v'));

      let steps = spec().withGCEnabled(false);

      const docs = [];

      for (let i = 0; i < cachedDocumentCount; ++i) {
        steps.userSets(`collection/${i}`, { v: i });
        docs.push(
          doc(`collection/${i}`, 0, { v: i }, { hasLocalMutations: true })
        );
      }

      for (let i = 1; i <= STEP_COUNT; ++i) {
        steps = steps
          .userListens(query)
          .expectEvents(query, {
            added: docs,
            fromCache: true,
            hasPendingWrites: true
          })
          .userUnlistens(query);
      }

      return steps;
    });

    specTest('Update a single document', [], () => {
      let steps = spec().withGCEnabled(false);
      steps = steps.userSets(`collection/doc`, { v: 0 });
      for (let i = 1; i <= STEP_COUNT; ++i) {
        steps = steps.userPatches(`collection/doc`, { v: i }).writeAcks(i);
      }
      return steps;
    });

    specTest(
      'Update a document and wait for snapshot with existing listen',
      [],
      () => {
        const query = Query.atPath(path(`collection/doc`));

        let currentVersion = 1;
        let steps = spec().withGCEnabled(false);

        let docLocal = doc(
          `collection/doc`,
          0,
          { v: 0 },
          { hasLocalMutations: true }
        );
        let docRemote = doc(`collection/doc`, ++currentVersion, { v: 0 });
        let lastRemoteVersion = currentVersion;

        steps = steps
          .userListens(query)
          .userSets(`collection/doc`, { v: 0 })
          .expectEvents(query, {
            added: [docLocal],
            fromCache: true,
            hasPendingWrites: true
          })
          .writeAcks(++currentVersion)
          .watchAcksFull(query, ++currentVersion, docRemote)
          .expectEvents(query, { metadata: [docRemote] });

        for (let i = 1; i <= STEP_COUNT; ++i) {
          docLocal = doc(
            `collection/doc`,
            lastRemoteVersion,
            { v: i },
            { hasLocalMutations: true }
          );
          docRemote = doc(`collection/doc`, ++currentVersion, { v: i });
          lastRemoteVersion = currentVersion;

          steps = steps
            .userPatches(`collection/doc`, { v: i })
            .expectEvents(query, {
              modified: [docLocal],
              hasPendingWrites: true
            })
            .writeAcks(++currentVersion)
            .watchSends({ affects: [query] }, docRemote)
            .watchSnapshots(++currentVersion)
            .expectEvents(query, { metadata: [docRemote] });
        }
        return steps;
      }
    );

    specTest(
      'Process 100 documents from Watch and wait for snapshot',
      [],
      () => {
        const documentsPerStep = 100;

        const query = Query.atPath(path(`collection`)).addOrderBy(orderBy('v'));

        let currentVersion = 1;
        let steps = spec().withGCEnabled(false);

        steps = steps
          .userListens(query)
          .watchAcksFull(query, currentVersion)
          .expectEvents(query, {});

        for (let i = 1; i <= STEP_COUNT; ++i) {
          const docs = [];

          for (let j = 0; j < documentsPerStep; ++j) {
            docs.push(
              doc(`collection/${j}`, ++currentVersion, { v: currentVersion })
            );
          }

          const changeType = i === 1 ? 'added' : 'modified';

          steps = steps
            .watchSends({ affects: [query] }, ...docs)
            .watchSnapshots(++currentVersion)
            .expectEvents(query, { [changeType]: docs });
        }

        return steps;
      }
    );

    specTest(
      'Process 100 documents from Watch and wait for snapshot, then unlisten and wait for a cached snapshot',
      [],
      () => {
        const documentsPerStep = 100;

        let currentVersion = 1;
        let steps = spec().withGCEnabled(false);

        for (let i = 1; i <= STEP_COUNT; ++i) {
          const collPath = `collection/${i}/coll`;
          const query = Query.atPath(path(collPath)).addOrderBy(orderBy('v'));

          const docs = [];
          for (let j = 0; j < documentsPerStep; ++j) {
            docs.push(doc(`${collPath}/${j}`, ++currentVersion, { v: j }));
          }

          steps = steps
            .userListens(query)
            .watchAcksFull(query, ++currentVersion, ...docs)
            .expectEvents(query, { added: docs })
            .userUnlistens(query)
            .watchRemoves(query)
            .userListens(query, 'resume-token-' + currentVersion)
            .expectEvents(query, { added: docs, fromCache: true })
            .watchAcksFull(query, ++currentVersion)
            .expectEvents(query, {})
            .userUnlistens(query)
            .watchRemoves(query);
        }

        return steps;
      }
    );
  }
);
