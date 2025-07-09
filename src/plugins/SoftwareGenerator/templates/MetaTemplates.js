/*globals define*/
/*
 * Финальная версия генератора YAML для Home Assistant.
 * Корректно обрабатывает круговые ссылки при сохранении модели в JSON.
 */
define([
    'bower/js-yaml/dist/js-yaml.min', 
], function (
    jsyaml
) {
    'use strict';

    // --- Вспомогательные функции ---
    const toSnakeCase = (str) => {
        if (!str) return '';
        return str.replace(/[\s\W]+/g, '_')
                  .replace(/([A-Z])/g, '_$1')
                  .replace(/__+/g, '_')
                  .replace(/^_|_$/g, '')
                  .toLowerCase();
    };
    
    const safeLoadYamlAction = (yamlString, logger) => {
        if (!yamlString || typeof yamlString !== 'string' || yamlString.trim() === '') return [];
        try {
            const parsed = jsyaml.load(yamlString);
            if (Array.isArray(parsed)) return parsed;
            if (typeof parsed === 'object' && parsed !== null) return [parsed];
            (logger || console).warn(`Содержимое YAML было разобрано, но не является объектом/массивом: ${yamlString}`);
            return [];
        } catch (e) {
            (logger || console).warn(`Не удалось разобрать строку YAML. Ошибка: ${e.message}. Содержимое: "${yamlString}"`);
            return [];
        }
    };

    /**
     * НОВАЯ ФУНКЦИЯ: Создает "заменитель" для JSON.stringify, который обрабатывает круговые ссылки.
     * @returns {function} Replacer-функция.
     */
    const getCircularReplacer = () => {
        const seen = new WeakSet();
        return (key, value) => {
            // Если значение - объект и мы его уже видели, то прерываем цикл.
            if (typeof value === "object" && value !== null) {
                if (seen.has(value)) {
                    return; // Возвращаем undefined, чтобы JSON.stringify пропустил это свойство.
                }
                seen.add(value);
            }
            return value;
        };
    };

    function buildActionSequence(transition, objects, smSnakeName, logger) {
        // ... (эта функция остается без изменений)
        let sequence = [];
        const targetNode = objects[transition.pointers.dst];
        sequence.push(...safeLoadYamlAction(transition.attributes.Action, logger));
        if (targetNode.type === 'State' || targetNode.type === 'End State') {
            sequence.push({
                service: 'input_select.select_option',
                target: { entity_id: `input_select.${smSnakeName}` },
                data: { option: toSnakeCase(targetNode.sanitizedName) }
            });
            sequence.push(...safeLoadYamlAction(targetNode.attributes.Entry, logger));
        } else if (targetNode.type === 'Choice Pseudostate') {
            const outgoingFromChoice = Object.values(objects)
                .filter(o => o.type === 'External Transition' && o.pointers.src === targetNode.path);
            const defaultBranch = outgoingFromChoice.find(t => !t.attributes.Guard);
            const guardedBranches = outgoingFromChoice.filter(t => t.attributes.Guard);
            const innerChoose = {
                choose: guardedBranches.map(branch => ({
                    conditions: [{
                        condition: 'template',
                        value_template: `{{ ${branch.attributes.Guard.replace(/^\[|\]$/g, '').trim()} }}`
                    }],
                    sequence: buildActionSequence(branch, objects, smSnakeName, logger)
                }))
            };
            if (defaultBranch) {
                innerChoose.default = buildActionSequence(defaultBranch, objects, smSnakeName, logger);
            }
            sequence.push(innerChoose);
        }
        return sequence;
    }

    return {
        renderHFSM: function (model, namespace, objToFilePrefixFn) {
            const logger = this.logger || console;
            const objects = model.objects;
            let generatedArtifacts = {};

            const smRoot = Object.values(objects).find(o => o.type === 'State Machine');
            if (!smRoot) {
                logger.warn('Не найдена "State Machine" в модели.');
                return {};
            }

            const smSnakeName = toSnakeCase(smRoot.sanitizedName);
            const inputSelectEntityId = `input_select.${smSnakeName}`;
            const eventType = `${smSnakeName}_event`;

            const states = Object.values(objects).filter(o => o.type === 'State' || o.type === 'End State');
            const transitions = Object.values(objects).filter(o => o.type === 'External Transition' || o.type === 'Internal Transition');
            
            let initialStateName = null;
            const initialTransition = transitions.find(t => objects[t.pointers.src] && objects[t.pointers.src].type === 'Initial');
            if (initialTransition && objects[initialTransition.pointers.dst]) {
                initialStateName = toSnakeCase(objects[initialTransition.pointers.dst].sanitizedName);
            }

            // --- Генерация YAML (без изменений) ---
            let haConfig = {};
            haConfig.input_select = {};
            haConfig.input_select[smSnakeName] = { name: smRoot.sanitizedName, options: states.map(s => toSnakeCase(s.sanitizedName)), initial: initialStateName, icon: 'mdi:state-machine' };
            const mainChoose = [];
            for (const state of states) {
                const outgoingTransitions = transitions.filter(t => t.pointers.src === state.path);
                for (const trans of outgoingTransitions) {
                    const eventName = trans.attributes.Event;
                    if (!eventName) continue;
                    let sequence = [];
                    if (trans.type === 'External Transition') {
                        sequence.push(...safeLoadYamlAction(state.attributes.Exit, logger));
                        sequence.push(...buildActionSequence(trans, objects, smSnakeName, logger));
                    } else {
                        sequence.push(...safeLoadYamlAction(trans.attributes.Action, logger));
                    }
                    mainChoose.push({
                        conditions: [
                            { condition: 'state', entity_id: inputSelectEntityId, state: toSnakeCase(state.sanitizedName) },
                            { condition: 'template', value_template: `{{ trigger.event.data.event == '${eventName}' }}` }
                        ],
                        sequence: sequence
                    });
                }
            }
            haConfig.automation = [{ id: `${smSnakeName}_automation`, alias: `State Machine: ${smRoot.sanitizedName}`, description: `Handles state transitions for ${smRoot.sanitizedName}`, mode: 'single', trigger: [{ platform: 'event', event_type: eventType }], action: [{ choose: mainChoose }] }];
            
            // --- Создание артефакта YAML ---
            const yamlString = jsyaml.dump(haConfig, { indent: 2, lineWidth: -1, noRefs: true });
            const fileHeader = `#\n# Auto-generated Home Assistant configuration for "${smRoot.sanitizedName}" state machine.\n` +
                             `# Generated by WebGME plugin on ${new Date().toISOString()}\n#\n\n`;
            const yamlFileName = `${smSnakeName}.yaml`;
            generatedArtifacts[yamlFileName] = fileHeader + yamlString;
            
            // --- Сохранение оригинальной модели в JSON с обработкой циклов ---
            logger.info('Сохранение исходной модели в JSON для отладки...');
            
            // ИЗМЕНЕННАЯ СТРОКА: Используем наш новый replacer
            const jsonModelString = JSON.stringify(model, getCircularReplacer(), 2);
            
            const jsonModelFileName = `${smSnakeName}_model.json`;
            generatedArtifacts[jsonModelFileName] = jsonModelString;

            return generatedArtifacts;
        },

        renderTestCode: function (model, namespace, objToFilePrefixFn) {
            return {};
        }
    };
});