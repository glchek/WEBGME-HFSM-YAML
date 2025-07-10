/*globals define*/
/*
 * Финальная версия генератора YAML для Home Assistant.
 * Генерирует уникальные, стабильные ID для состояний на основе их пути в модели,
 * что решает проблему дублирующихся имен.
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
        // ... (без изменений)
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

    const getCircularReplacer = () => {
        // ... (без изменений)
        const seen = new WeakSet();
        return (key, value) => {
            if (typeof value === "object" && value !== null) {
                if (seen.has(value)) {
                    return;
                }
                seen.add(value);
            }
            return value;
        };
    };
    
    /**
     * НОВАЯ ФУНКЦИЯ: Генерирует уникальный и стабильный ID для состояния.
     * Формат: 'имя_состояния_путь_к_узлу'
     * @param {object} stateNode - Узел состояния из модели WebGME.
     * @returns {string} Уникальный ID.
     */
    const generateUniqueStateId = (stateNode) => {
        const namePart = toSnakeCase(stateNode.sanitizedName);
        // Используем путь к узлу, так как он гарантированно уникален в модели
        const pathPart = stateNode.path.replace(/\//g, '_');
        return `${namePart}${pathPart}`;
    };

    function buildActionSequence(transition, objects, smSnakeName, logger, stateIdMap) {
        let sequence = [];
        const targetNode = objects[transition.pointers.dst];

        sequence.push(...safeLoadYamlAction(transition.attributes.Action, logger));
        
        if (targetNode.type === 'State' || targetNode.type === 'End State') {
            sequence.push({
                service: 'input_select.select_option',
                target: { entity_id: `input_select.${smSnakeName}` },
                // ИСПОЛЬЗУЕМ КАРТУ ID
                data: { option: stateIdMap.get(targetNode) }
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
                    // ПРОБРАСЫВАЕМ КАРТУ ID ДАЛЬШЕ
                    sequence: buildActionSequence(branch, objects, smSnakeName, logger, stateIdMap)
                }))
            };
            if (defaultBranch) {
                // ПРОБРАСЫВАЕМ КАРТУ ID ДАЛЬШЕ
                innerChoose.default = buildActionSequence(defaultBranch, objects, smSnakeName, logger, stateIdMap);
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
            
            // --- СОЗДАНИЕ КАРТЫ УНИКАЛЬНЫХ ID ДЛЯ СОСТОЯНИЙ ---
            const stateIdMap = new Map();
            states.forEach(state => {
                stateIdMap.set(state, generateUniqueStateId(state));
            });

            let initialUniqueStateId = null;
            const initialTransition = transitions.find(t => objects[t.pointers.src] && objects[t.pointers.src].type === 'Initial');
            if (initialTransition) {
                const initialTargetState = objects[initialTransition.pointers.dst];
                if (initialTargetState) {
                    // ИСПОЛЬЗУЕМ КАРТУ ID
                    initialUniqueStateId = stateIdMap.get(initialTargetState);
                }
            }

            // --- Генерация YAML ---
            let haConfig = {};
            haConfig.input_select = {};
            haConfig.input_select[smSnakeName] = { 
                name: smRoot.sanitizedName, 
                // ИСПОЛЬЗУЕМ КАРТУ ID
                options: states.map(s => stateIdMap.get(s)), 
                initial: initialUniqueStateId, 
                icon: 'mdi:state-machine' 
            };
            
            const mainChoose = [];
            for (const state of states) {
                const outgoingTransitions = transitions.filter(t => t.pointers.src === state.path);
                for (const trans of outgoingTransitions) {
                    const eventName = trans.attributes.Event;
                    if (!eventName) continue;
                    let sequence = [];
                    if (trans.type === 'External Transition') {
                        sequence.push(...safeLoadYamlAction(state.attributes.Exit, logger));
                        // ПРОБРАСЫВАЕМ КАРТУ ID
                        sequence.push(...buildActionSequence(trans, objects, smSnakeName, logger, stateIdMap));
                    } else {
                        sequence.push(...safeLoadYamlAction(trans.attributes.Action, logger));
                    }
                    mainChoose.push({
                        conditions: [
                            // ИСПОЛЬЗУЕМ КАРТУ ID
                            { condition: 'state', entity_id: inputSelectEntityId, state: stateIdMap.get(state) },
                            { condition: 'template', value_template: `{{ trigger.event.data.event == '${eventName}' }}` }
                        ],
                        sequence: sequence
                    });
                }
            }
            
            haConfig.automation = [{ id: `${smSnakeName}_automation`, alias: `State Machine: ${smRoot.sanitizedName}`, description: `Handles state transitions for ${smRoot.sanitizedName}`, mode: 'single', trigger: [{ platform: 'event', event_type: eventType }], action: [{ choose: mainChoose }] }];
            
            // --- Создание артефактов (без изменений) ---
            const yamlString = jsyaml.dump(haConfig, { indent: 2, lineWidth: -1, noRefs: true });
            const fileHeader = `#\n# Auto-generated Home Assistant configuration for "${smRoot.sanitizedName}" state machine.\n` +
                             `# Generated by WebGME plugin on ${new Date().toISOString()}\n#\n\n`;
            const yamlFileName = `${smSnakeName}.yaml`;
            generatedArtifacts[yamlFileName] = fileHeader + yamlString;
            
            logger.info('Сохранение исходной модели в JSON для отладки...');
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