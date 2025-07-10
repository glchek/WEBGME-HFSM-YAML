/*globals define*/
/*
 * Финальная, отказоустойчивая версия генератора YAML для Home Assistant.
 * Написана с использованием "защитного программирования" для предотвращения сбоев
 * из-за неполных или некорректных данных в модели.
 */
define([
    'bower/js-yaml/dist/js-yaml.min', 
], function (
    jsyaml
) {
    'use strict';

    // --- Вспомогательные функции (без изменений) ---
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
            (logger || console).warn(`Не удалось разобрать строку YAML как действие. Ошибка: ${e.message}. Содержимое: "${yamlString}"`);
            return [];
        }
    };

    const getCircularReplacer = () => {
        const seen = new WeakSet();
        return (key, value) => {
            if (typeof value === "object" && value !== null) {
                if (seen.has(value)) return;
                seen.add(value);
            }
            return value;
        };
    };
    
    const generateUniqueStateId = (stateNode) => {
        const namePart = toSnakeCase(stateNode.sanitizedName);
        const pathPart = stateNode.path.replace(/\//g, '_');
        return `${namePart}${pathPart}`;
    };

    // Рекурсивная функция, переписанная с учетом проверок
    function buildTransitionSequence(transition, allObjects, smSnakeName, logger, stateIdMap) {
        let sequence = [];

        // ЗАЩИТА: Проверяем наличие атрибутов перед использованием
        if (transition.attributes && transition.attributes.Action) {
            sequence.push(...safeLoadYamlAction(transition.attributes.Action, logger));
        }

        // ЗАЩИТА: Проверяем, что у перехода есть указатели и цель
        if (!transition.pointers || !transition.pointers.dst) {
            logger.warn(`У перехода по пути ${transition.path} отсутствует указатель на цель (dst).`);
            return sequence;
        }
        
        const targetNode = allObjects[transition.pointers.dst];
        if (!targetNode) {
            logger.warn(`Цель перехода ${transition.pointers.dst} не найдена в модели.`);
            return sequence;
        }

        if (targetNode.type === 'State' || targetNode.type === 'End State') {
            sequence.push({
                service: 'input_select.select_option',
                target: { entity_id: `input_select.${smSnakeName}` },
                data: { option: stateIdMap.get(targetNode) }
            });
            if (targetNode.attributes && targetNode.attributes.Entry) {
                sequence.push(...safeLoadYamlAction(targetNode.attributes.Entry, logger));
            }
        } else if (targetNode.type === 'Choice Pseudostate') {
            const outgoingFromChoice = Object.values(allObjects)
                .filter(o => o && o.type === 'External Transition' && o.pointers && o.pointers.src === targetNode.path);
            
            const defaultBranch = outgoingFromChoice.find(t => t.attributes && !t.attributes.Guard);
            const guardedBranches = outgoingFromChoice.filter(t => t.attributes && t.attributes.Guard);

            const innerChoose = {
                choose: guardedBranches.map(branch => ({
                    conditions: [{
                        condition: 'template',
                        value_template: `{{ ${branch.attributes.Guard.replace(/^\[|\]$/g, '').trim()} }}`
                    }],
                    sequence: buildTransitionSequence(branch, allObjects, smSnakeName, logger, stateIdMap)
                }))
            };
            
            if (defaultBranch) {
                innerChoose.default = buildTransitionSequence(defaultBranch, allObjects, smSnakeName, logger, stateIdMap);
            }

            sequence.push(innerChoose);
        }
        return sequence;
    }

    return {
        renderHFSM: function (model, namespace, objToFilePrefixFn) {
            const logger = this.logger || console;
            const allObjects = model.objects;
            let generatedArtifacts = {};

            const smRoot = Object.values(allObjects).find(o => o && o.type === 'State Machine');
            if (!smRoot) {
                logger.error('Не найдена "State Machine" в модели. Прерывание.');
                return {};
            }

            const smSnakeName = toSnakeCase(smRoot.sanitizedName);
            const inputSelectEntityId = `input_select.${smSnakeName}`;
            const eventType = `${smSnakeName}_event`;

            const states = Object.values(allObjects).filter(o => o && (o.type === 'State' || o.type === 'End State'));
            const transitions = Object.values(allObjects).filter(o => o && (o.type === 'External Transition' || o.type === 'Internal Transition'));
            
            const stateIdMap = new Map();
            states.forEach(state => stateIdMap.set(state, generateUniqueStateId(state)));

            let initialUniqueStateId = null;
            const initialTransition = Object.values(allObjects).find(t => t && t.src && t.src.type === 'Initial');
            if (initialTransition && initialTransition.dst) {
                initialUniqueStateId = stateIdMap.get(initialTransition.dst);
            }
            
            let haConfig = {};
            haConfig.input_select = {};
            haConfig.input_select[smSnakeName] = { 
                name: smRoot.sanitizedName, 
                options: states.map(s => stateIdMap.get(s)), 
                initial: initialUniqueStateId, 
                icon: 'mdi:state-machine' 
            };
            
            const mainChoose = [];
            for (const state of states) {
                // ЗАЩИТА: Проверяем, что у состояния есть путь
                if (!state || !state.path) continue;
                
                // ПРАВИЛЬНЫЙ И БЕЗОПАСНЫЙ ПОИСК ПЕРЕХОДОВ
                const externalTransitions = transitions.filter(t => t && t.type === 'External Transition' && t.pointers && t.pointers.src === state.path);
                const internalTransitions = transitions.filter(t => t && t.type === 'Internal Transition' && t.parentPath === state.path);
                const allStateTransitions = [...externalTransitions, ...internalTransitions];

                for (const trans of allStateTransitions) {
                    // ЗАЩИТА: Проверяем, что у перехода есть атрибуты и имя события
                    const eventName = trans.attributes && trans.attributes.Event;
                    if (!eventName) continue;
                    
                    let sequence = [];
                    if (trans.type === 'External Transition') {
                        if (state.attributes && state.attributes.Exit) {
                            sequence.push(...safeLoadYamlAction(state.attributes.Exit, logger));
                        }
                        sequence.push(...buildTransitionSequence(trans, allObjects, smSnakeName, logger, stateIdMap));
                    } else { // Internal Transition
                        if (trans.attributes && trans.attributes.Action) {
                            sequence.push(...safeLoadYamlAction(trans.attributes.Action, logger));
                        }
                    }

                    if (sequence.length > 0) {
                        mainChoose.push({
                            conditions: [
                                { condition: 'state', entity_id: inputSelectEntityId, state: stateIdMap.get(state) },
                                { condition: 'template', value_template: `{{ trigger.event.data.event == '${eventName}' }}` }
                            ],
                            sequence: sequence
                        });
                    }
                }
            }
            
            haConfig.automation = [{ id: `${smSnakeName}_automation`, alias: `State Machine: ${smRoot.sanitizedName}`, description: `Handles state transitions for ${smRoot.sanitizedName}`, mode: 'single', trigger: [{ platform: 'event', event_type: eventType }], action: [{ choose: mainChoose }] }];
            
            const yamlString = jsyaml.dump(haConfig, { indent: 2, lineWidth: -1, noRefs: true });
            const fileHeader = `#\n# Auto-generated Home Assistant configuration for "${smRoot.sanitizedName}" state machine.\n` +
                             `# Generated by WebGME plugin on ${new Date().toISOString()}\n\n`;
            const yamlFileName = `${smSnakeName}.yaml`;
            generatedArtifacts[yamlFileName] = fileHeader + yamlString;
            
            const jsonModelString = JSON.stringify(model, getCircularReplacer(), 2);
            const jsonModelFileName = `${smSnakeName}_model.json`;
            generatedArtifacts[jsonModelFileName] = jsonModelString;

            return generatedArtifacts;
        },
        
        renderTestCode: function () {
            return {};
        }
    };
});